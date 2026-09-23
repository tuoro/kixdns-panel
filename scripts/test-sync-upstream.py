#!/usr/bin/env python3
"""每日同步工作流的离线测试。

从 .github/workflows/sync-upstream.yml 读出真实的步骤：按 GitHub 的规则求值每一步的
if 条件和 env 表达式，在临时仓库里执行 run 脚本；gh 和 cargo 换成记录调用的假命令，
origin 是本地裸仓库。这样条件、步骤之间的输出传递和脚本本身都在测试里，而这些路径
平时只有在上游或安全公告真的变化时才会运行。

Offline test for the daily sync workflow. It reads the real steps from
sync-upstream.yml, evaluates each step's `if` condition and `env` expressions the way
GitHub does, and runs the `run` scripts in a scratch repository. gh and cargo are
stubs that record their calls, and origin is a local bare repository. Conditions,
output wiring between steps and the scripts themselves are all covered, although on
GitHub these paths only run when upstream or an advisory actually changes.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent
WORKFLOW = WORKSPACE / ".github/workflows/sync-upstream.yml"
FIRST_SIMULATED_STEP = "Prepare candidate lock"
# 只从外部下载东西的步骤：测试里当作成功，不访问网络。
# Steps that only download external resources: treated as successful, no network.
EXTERNAL_STEPS = {"Fetch RustSec advisory database"}


# ---------------------------------------------------------------- workflow parsing


@dataclass
class Step:
    name: str
    id: str | None = None
    condition: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    run: str | None = None
    uses: str | None = None
    continue_on_error: bool = False


def parse_steps(text: str) -> list[Step]:
    """只认本工作流用到的写法；格式超出范围就直接报错，而不是悄悄漏测。
    Accepts only the forms this workflow uses and fails loudly on anything else."""
    lines = text.split("\n")
    start = lines.index("    steps:") + 1
    steps: list[Step] = []
    index = start
    while index < len(lines):
        line = lines[index]
        if not line.strip() or line.lstrip().startswith("#"):
            index += 1
            continue
        match = re.match(r"^      - (\w[\w-]*): ?(.*)$", line)
        if match:
            steps.append(Step(name=""))
            line = "        " + f"{match.group(1)}: {match.group(2)}"
        elif not line.startswith("        "):
            break
        key_match = re.match(r"^        (\w[\w-]*):(?: (.*))?$", line)
        if not key_match:
            raise ValueError(f"无法解析的步骤行：{line!r}")
        key, value = key_match.group(1), (key_match.group(2) or "").strip()
        step = steps[-1]
        index += 1
        block: list[str] = []
        while index < len(lines) and (
            not lines[index].strip() or lines[index].startswith("          ")
        ):
            block.append(lines[index])
            index += 1
        if key == "name":
            step.name = value
        elif key == "id":
            step.id = value
        elif key == "if":
            step.condition = (
                " ".join(part.strip() for part in block if part.strip())
                if value == ">-"
                else value
            )
        elif key == "run":
            step.run = (
                "\n".join(part[10:] for part in block) if value == "|" else value
            )
        elif key == "env":
            for part in block:
                env_match = re.match(r"^          (\w+): (.*)$", part)
                if env_match:
                    step.env[env_match.group(1)] = env_match.group(2).strip()
        elif key == "uses":
            step.uses = value
        elif key == "continue-on-error":
            step.continue_on_error = value == "true"
        elif key not in {"shell", "with"}:
            raise ValueError(f"未支持的步骤键：{key}")
    return steps


# ------------------------------------------------------------ expression evaluation

TOKEN = re.compile(
    r"\s*(?:(?P<string>'(?:[^']|'')*')|(?P<op>&&|\|\||==|!=|!|\(|\))"
    r"|(?P<name>[A-Za-z_][\w.-]*))"
)


class Expression:
    """GitHub 表达式里本工作流用到的子集：字符串、上下文属性、状态函数、==、!=、!、&&、||。
    The subset of GitHub expressions this workflow uses."""

    def __init__(self, text: str, context: "Context"):
        self.tokens: list[tuple[str, str]] = []
        position = 0
        while position < len(text):
            if text[position:].strip() == "":
                break
            match = TOKEN.match(text, position)
            if not match or match.end() == position:
                raise ValueError(f"无法解析的表达式：{text!r}")
            kind = match.lastgroup
            self.tokens.append((kind, match.group(kind)))
            position = match.end()
        self.position = 0
        self.context = context

    def evaluate(self):
        value = self.or_expression()
        if self.position != len(self.tokens):
            raise ValueError(f"表达式有多余内容：{self.tokens[self.position:]}")
        return value

    def peek(self):
        return self.tokens[self.position] if self.position < len(self.tokens) else (None, None)

    def take(self, expected=None):
        token = self.peek()
        if expected is not None and token[1] != expected:
            raise ValueError(f"期望 {expected}，实际 {token}")
        self.position += 1
        return token

    def or_expression(self):
        value = self.and_expression()
        while self.peek()[1] == "||":
            self.take()
            right = self.and_expression()
            value = value if truthy(value) else right
        return value

    def and_expression(self):
        value = self.comparison()
        while self.peek()[1] == "&&":
            self.take()
            right = self.comparison()
            value = right if truthy(value) else value
        return value

    def comparison(self):
        value = self.unary()
        while self.peek()[1] in {"==", "!="}:
            operator = self.take()[1]
            right = self.unary()
            equal = text_of(value).lower() == text_of(right).lower()
            value = equal if operator == "==" else not equal
        return value

    def unary(self):
        if self.peek()[1] == "!":
            self.take()
            return not truthy(self.unary())
        return self.primary()

    def primary(self):
        kind, value = self.take()
        if value == "(":
            inner = self.or_expression()
            self.take(")")
            return inner
        if kind == "string":
            return value[1:-1].replace("''", "'")
        if kind == "name":
            if self.peek()[1] == "(":
                self.take("(")
                self.take(")")
                return self.context.function(value)
            return self.context.lookup(value)
        raise ValueError(f"意外的记号：{value}")


def truthy(value) -> bool:
    return bool(value)


def text_of(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


# ---------------------------------------------------------------------- job runner


@dataclass
class Context:
    outputs: dict[str, dict[str, str]]
    outcomes: dict[str, str]
    failed: bool = False
    event_name: str = "schedule"

    def lookup(self, name: str):
        parts = name.split(".")
        if parts[0] == "steps" and len(parts) >= 3:
            step_id = parts[1]
            if step_id not in self.outcomes and step_id not in self.outputs:
                raise ValueError(f"条件引用了不存在的步骤：{name}")
            if parts[2] == "outputs" and len(parts) == 4:
                return self.outputs.get(step_id, {}).get(parts[3], "")
            if parts[2] in {"outcome", "conclusion"} and len(parts) == 3:
                return self.outcomes.get(step_id, "skipped")
        if name == "github.event_name":
            return self.event_name
        raise ValueError(f"未支持的上下文：{name}")

    def function(self, name: str):
        return {
            "success": not self.failed,
            "failure": self.failed,
            "always": True,
            "cancelled": False,
        }[name]


STATUS_FUNCTION = re.compile(r"\b(success|failure|always|cancelled)\(\)")


def substitute(value: str, context: Context) -> str:
    def replace(match):
        return text_of(Expression(match.group(1), context).evaluate())

    return re.sub(r"\$\{\{(.*?)\}\}", replace, value)


@dataclass
class Result:
    ran: list[str]
    context: Context
    logs: dict[str, str]


def run_job(
    steps: list[Step],
    repository: Path,
    base_env: dict[str, str],
    upstream_outputs: dict[str, str],
    start: str = FIRST_SIMULATED_STEP,
) -> Result:
    known_ids = {step.id for step in steps if step.id}
    context = Context(outputs={"upstream": dict(upstream_outputs)}, outcomes={"upstream": "success"})
    for step_id in known_ids - {"upstream"}:
        context.outcomes[step_id] = "skipped"
    runner_temp = Path(base_env["RUNNER_TEMP"])
    env_file = runner_temp / "github-env"
    env_file.write_text("")
    ran: list[str] = []
    logs: dict[str, str] = {}
    started = False
    for step in steps:
        if step.name == start:
            started = True
        if not started:
            continue
        condition = step.condition or "success()"
        if not STATUS_FUNCTION.search(condition):
            condition = f"success() && ({condition})"
        if not truthy(Expression(condition, context).evaluate()):
            continue
        ran.append(step.name)
        if step.uses or step.run is None or step.name in EXTERNAL_STEPS:
            if step.id:
                context.outcomes[step.id] = "success"
            continue
        output_file = runner_temp / f"output-{len(ran)}"
        output_file.write_text("")
        environment = dict(base_env)
        for line in env_file.read_text().splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                environment[key] = value
        for key, value in step.env.items():
            environment[key] = substitute(value, context)
        environment["GITHUB_OUTPUT"] = str(output_file)
        environment["GITHUB_ENV"] = str(env_file)
        script = runner_temp / f"step-{len(ran)}.sh"
        script.write_text(step.run)
        completed = subprocess.run(
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],
            cwd=repository,
            env=environment,
            capture_output=True,
            text=True,
        )
        logs[step.name] = completed.stdout + completed.stderr
        outcome = "success" if completed.returncode == 0 else "failure"
        if step.id:
            context.outcomes[step.id] = outcome
            context.outputs[step.id] = dict(
                line.split("=", 1)
                for line in output_file.read_text().splitlines()
                if "=" in line
            )
        if outcome == "failure" and not step.continue_on_error:
            context.failed = True
    return Result(ran=ran, context=context, logs=logs)


# ------------------------------------------------------------------ fixture + stubs

GH_STUB = r'''#!/usr/bin/env python3
import base64, json, os, subprocess, sys
state_path = os.environ["STUB_STATE"]
state = json.load(open(state_path))
args = sys.argv[1:]
def log(entry):
    state["calls"].append(entry)
def option(name):
    return args[args.index(name) + 1] if name in args else None
def save():
    json.dump(state, open(state_path, "w"), ensure_ascii=False, indent=1)
if args[:2] == ["pr", "list"]:
    pass
elif args[:2] == ["pr", "create"]:
    state["pr_head"] = option("--head")
    log({"pr": "create", "head": option("--head"), "title": option("--title"),
         "body": open(option("--body-file")).read()})
    print("https://github.com/tuoro/kixdns-panel/pull/999")
elif args[:2] == ["pr", "merge"]:
    subprocess.run(["git", "-C", state["origin"], "update-ref", "refs/heads/main",
                    "refs/heads/" + state["pr_head"]], check=True)
    log({"pr": "merge"})
elif args[:2] == ["pr", "view"]:
    print("MERGED")
elif args[:2] == ["issue", "list"]:
    print(json.dumps(state["issues"], ensure_ascii=False))
elif args[:2] == ["issue", "create"]:
    number = max([issue["number"] for issue in state["issues"]] + [100]) + 1
    state["issues"].append({"number": number, "title": option("--title")})
    log({"issue": "create", "title": option("--title"), "body": open(option("--body-file")).read()})
elif args[:2] == ["issue", "edit"]:
    log({"issue": "edit", "number": int(args[2]), "body": open(option("--body-file")).read()})
elif args[:2] == ["issue", "close"]:
    state["issues"] = [issue for issue in state["issues"] if issue["number"] != int(args[2])]
    log({"issue": "close", "number": int(args[2]), "comment": option("--comment")})
elif args[:1] == ["api"] and "/contents/" in args[1]:
    path = args[1].split("/contents/", 1)[1].split("?", 1)[0]
    content = subprocess.run(["git", "-C", state["origin"], "show", "main:" + path],
                             capture_output=True, check=True).stdout
    print(base64.encodebytes(content).decode(), end="")
elif args[:2] == ["workflow", "run"]:
    log({"workflow": args[2]})
else:
    sys.exit("unexpected gh " + " ".join(args))
save()
'''

CARGO_STUB = r'''#!/usr/bin/env python3
import json, os, sys
state_path = os.environ["STUB_STATE"]
state = json.load(open(state_path))
args = sys.argv[1:]
def option(name):
    return args[args.index(name) + 1] if name in args else None
def save():
    json.dump(state, open(state_path, "w"), ensure_ascii=False, indent=1)
if args[:1] != ["xtask"]:
    sys.exit(0)
command = args[1]
lock = option("--lock")
state["calls"].append({"cargo": command, "lock": lock})
save()
if command == "prepare":
    sys.exit(0)
if command == "checkout-dir":
    os.makedirs(".upstream/stub-checkout", exist_ok=True)
    print(".upstream/stub-checkout")
    sys.exit(0)
if command == "audit":
    data = json.load(open(lock))
    rule = state["audit"].get(lock, 0)
    if "dependency_revision" in data and state["refresh"] == "success":
        rule = 0
    if isinstance(rule, dict):
        patchset = str(json.load(open(lock))["patchset"])
        rule = rule[patchset]
    notices = option("--notices")
    if notices:
        open(notices, "w").write(state["notices"].get(lock, ""))
    print("依赖审计" + ("通过" if rule == 0 else "未通过") + "：" + lock)
    sys.exit(rule)
if command == "refresh-dependencies":
    if state["refresh"] == "unfixable":
        print("Error: 依赖无法在兼容版本内修复：\n- vulnerability demo 1.0.0 RUSTSEC-2099-0001")
        sys.exit(1)
    data = json.load(open(lock))
    reference = data["official_run_id"] if data["source"] == "action" else data["release_tag"]
    directory = f"patches/dependencies/{data['source']}/{reference}"
    os.makedirs(directory, exist_ok=True)
    open(f"{directory}/p{data['patchset']}-r1.patch", "w").write(
        "diff --git a/Cargo.lock b/Cargo.lock\n--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1 +1 @@\n-old\n+new\n")
    data["dependency_revision"] = 1
    open(lock, "w").write(json.dumps(data, indent=2) + "\n")
    print(f"已生成依赖修订 r1：{directory}")
    sys.exit(0)
sys.exit("unexpected cargo xtask " + " ".join(args[1:]))
'''


def git(repository: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repository), *args], check=True, capture_output=True, text=True
    ).stdout


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def action_lock(run_id: int, patchset: int) -> dict:
    return {
        "repository": "olicesx/kixdns",
        "source": "action",
        "commit": f"{run_id:040d}",
        "official_run_id": run_id,
        "patchset": patchset,
        "control_protocol": 1,
    }


def release_lock(tag: str, patchset: int, commit: str) -> dict:
    return {
        "repository": "olicesx/kixdns",
        "source": "release",
        "commit": commit,
        "release_id": 7,
        "release_tag": tag,
        "compatibility": "legacy",
        "patchset": patchset,
        "control_protocol": 1,
    }


@dataclass
class Fixture:
    root: Path
    repository: Path
    origin: Path
    state_path: Path
    env: dict[str, str]

    def state(self) -> dict:
        return json.loads(self.state_path.read_text())

    def calls(self, kind: str) -> list[dict]:
        return [call for call in self.state()["calls"] if kind in call]

    def origin_file(self, path: str) -> str | None:
        completed = subprocess.run(
            ["git", "-C", str(self.origin), "show", f"main:{path}"],
            capture_output=True,
            text=True,
        )
        return completed.stdout if completed.returncode == 0 else None


def make_fixture(root: Path, audit: dict, refresh: str = "success", notices=None,
                 issues=None) -> Fixture:
    repository = root / "repository"
    origin = root / "origin.git"
    scripts = repository / "scripts"
    scripts.mkdir(parents=True)
    for name in ["lock-reference.sh", "verify-patchsets.sh", "remove-unreferenced-patch-data.sh"]:
        shutil.copy(WORKSPACE / "scripts" / name, scripts / name)
    (scripts / "dns_smoke.py").write_text("print('ok')\n")
    for patchset in [1, 2, 3]:
        common = repository / f"patches/sets/{patchset}/common"
        common.mkdir(parents=True)
        (common / "0001-source.patch").write_text("diff --git a/src/lib.rs b/src/lib.rs\n")
        write_json(common.parent / "capabilities.json", {"schema_version": 1, "config_capabilities": []})
    legacy = repository / "patches/sets/2/compatibility/legacy"
    legacy.mkdir(parents=True)
    (legacy / "0000-legacy.patch").write_text("diff --git a/src/main.rs b/src/main.rs\n")
    for run_id, patchset in [(100, 1), (200, 2), (300, 3)]:
        write_json(repository / f"upstreams/actions/{run_id}.json", action_lock(run_id, patchset))
    write_json(repository / "upstream.lock.json", action_lock(300, 3))
    release = release_lock("v1", 2, "1" * 40)
    write_json(repository / "upstreams/releases/v1.json", release)
    write_json(repository / "upstream.release.lock.json", release)
    subprocess.run(["git", "init", "--quiet", "-b", "main", str(repository)], check=True)
    git(repository, "config", "user.name", "sync-test")
    git(repository, "config", "user.email", "sync-test@example.com")
    git(repository, "add", "--all")
    git(repository, "commit", "--quiet", "-m", "fixture")
    subprocess.run(["git", "init", "--quiet", "--bare", "-b", "main", str(origin)], check=True)
    git(repository, "remote", "add", "origin", str(origin))
    git(repository, "push", "--quiet", "origin", "main")

    bin_directory = root / "bin"
    bin_directory.mkdir()
    for name, content in [("gh", GH_STUB), ("cargo", CARGO_STUB)]:
        stub = bin_directory / name
        stub.write_text(content)
        stub.chmod(0o755)
    state_path = root / "stub-state.json"
    state_path.write_text(json.dumps({
        "origin": str(origin),
        "calls": [],
        "issues": issues or [],
        "audit": audit,
        "notices": notices or {},
        "refresh": refresh,
    }))
    runner_temp = root / "runner-temp"
    runner_temp.mkdir()
    advisory_db = root / "advisory-db"
    advisory_db.mkdir()
    env = {
        "PATH": f"{bin_directory}:{os.environ['PATH']}",
        "HOME": str(root),
        "STUB_STATE": str(state_path),
        "RUNNER_TEMP": str(runner_temp),
        "GITHUB_WORKSPACE": str(repository),
        "GITHUB_REPOSITORY": "tuoro/kixdns-panel",
        "GITHUB_SERVER_URL": "https://github.com",
        "GITHUB_RUN_ID": "1",
        "GITHUB_SHA": git(repository, "rev-parse", "HEAD").strip(),
        "BASE_SHA": git(repository, "rev-parse", "HEAD").strip(),
        "ADVISORY_DB": str(advisory_db),
        "GH_TOKEN": "stub",
        "GIT_AUTHOR_NAME": "sync-test",
        "GIT_AUTHOR_EMAIL": "sync-test@example.com",
        "GIT_COMMITTER_NAME": "sync-test",
        "GIT_COMMITTER_EMAIL": "sync-test@example.com",
    }
    return Fixture(root, repository, origin, state_path, env)


def unchanged_action() -> dict:
    return {
        "changed": "false",
        "commit": f"{300:040d}",
        "current": f"{300:040d}",
        "reference": "300",
        "lock_file": "upstream.lock.json",
        "label": "Action",
        "source_url": "https://github.com/olicesx/kixdns/actions/runs/300",
    }


# ------------------------------------------------------------------------ scenarios

FAILURES: list[str] = []


def check(scenario: str, condition: bool, message: str, result: Result | None = None) -> None:
    if condition:
        return
    detail = ""
    if result is not None:
        detail = "\n  已执行：" + " → ".join(result.ran)
        for name, log in result.logs.items():
            if log.strip():
                detail += f"\n  [{name}]\n    " + log.strip().replace("\n", "\n    ")
    FAILURES.append(f"{scenario}：{message}{detail}")


def scenario_refresh(steps: list[Step], root: Path) -> None:
    name = "当前版本审计不过，自动刷新并合并"
    fixture = make_fixture(
        root,
        audit={"upstream.lock.json": 3, "upstreams/actions/100.json": 3,
               "upstreams/actions/200.json": 0},
        notices={"upstream.lock.json": "- `old` 1.0.0 无人维护\n"},
        issues=[{"number": 7, "title": "[security] KixDNS Action 依赖需要人工处理"}],
    )
    result = run_job(steps, fixture.repository, {**fixture.env, "TRACK": "action"}, unchanged_action())
    context = result.context
    check(name, not context.failed, "作业应当成功", result)
    check(name, context.outputs.get("refresh", {}).get("revision") == "1", "应生成修订 r1", result)
    check(name, "Validate enhanced candidate" in result.ran, "刷新后必须完整验证", result)
    lock = json.loads(fixture.origin_file("upstream.lock.json") or "{}")
    check(name, lock.get("dependency_revision") == 1, "main 上的当前锁应记录修订", result)
    check(name, fixture.origin_file("upstreams/actions/300.json") == fixture.origin_file("upstream.lock.json"),
          "版本目录副本必须与当前锁一致", result)
    check(name, fixture.origin_file("patches/dependencies/action/300/p3-r1.patch") is not None,
          "修订文件应合并到 main", result)
    check(name, fixture.origin_file("upstreams/actions/100.json") is None, "审计不过的旧版本应移出", result)
    check(name, fixture.origin_file("upstreams/actions/200.json") is not None, "审计通过的旧版本应保留", result)
    check(name, fixture.origin_file("patches/sets/1/common/0001-source.patch") is None,
          "不再被引用的补丁集应删除", result)
    pull_requests = fixture.calls("pr")
    created = [call for call in pull_requests if call["pr"] == "create"]
    check(name, len(created) == 1 and created[0]["head"] == "automation/dependencies-action-300-r1"
          and created[0]["title"] == "chore: refresh action dependencies", f"PR 分支或标题不对：{created}", result)
    check(name, bool(created) and "p3-r1" in created[0]["body"] and "`100`" in created[0]["body"],
          "PR 正文应写明修订和移出的版本", result)
    check(name, fixture.calls("workflow") == [{"workflow": "build-kixdns.yml"}], "应触发 Action 构建", result)
    issues = fixture.calls("issue")
    check(name, {"issue": "close", "number": 7, "comment": "当前版本已通过 RustSec 审计，告警自动关闭。"} in issues,
          "安全告警应自动关闭", result)
    notice = [call for call in issues if call["issue"] == "create"]
    check(name, len(notice) == 1 and notice[0]["title"] == "[notice] KixDNS Action 依赖提示"
          and "`old` 1.0.0 无人维护" in notice[0]["body"], f"应开依赖提示告警：{issues}", result)


def scenario_unfixable(steps: list[Step], root: Path) -> None:
    name = "当前版本修不了，开安全告警"
    fixture = make_fixture(root, audit={"upstream.lock.json": 3}, refresh="unfixable")
    result = run_job(steps, fixture.repository, {**fixture.env, "TRACK": "action"}, unchanged_action())
    check(name, result.context.failed, "作业应当失败", result)
    check(name, "Merge validated upstream update" not in result.ran, "修不了时不能合并任何东西", result)
    created = [call for call in fixture.calls("issue") if call["issue"] == "create"]
    check(name, len(created) == 1 and created[0]["title"] == "[security] KixDNS Action 依赖需要人工处理"
          and "RUSTSEC-2099-0001" in created[0]["body"] and "`300`" in created[0]["body"],
          f"应开安全告警并附上失败原因：{created}", result)
    check(name, fixture.calls("workflow") == [], "不应触发构建", result)


def scenario_prune_only(steps: list[Step], root: Path) -> None:
    name = "当前版本正常，只清理旧版本"
    fixture = make_fixture(
        root,
        audit={"upstream.lock.json": 0, "upstreams/actions/100.json": 3,
               "upstreams/actions/200.json": 0},
        issues=[{"number": 8, "title": "[notice] KixDNS Action 依赖提示"}],
    )
    result = run_job(steps, fixture.repository, {**fixture.env, "TRACK": "action"}, unchanged_action())
    check(name, not result.context.failed, "作业应当成功", result)
    check(name, "Refresh dependencies" not in result.ran, "审计通过时不应刷新", result)
    created = [call for call in fixture.calls("pr") if call["pr"] == "create"]
    check(name, len(created) == 1 and created[0]["head"].startswith("automation/catalog-action-")
          and created[0]["title"] == "chore: prune action catalog", f"PR 分支或标题不对：{created}", result)
    check(name, fixture.origin_file("upstreams/actions/100.json") is None, "审计不过的旧版本应移出", result)
    check(name, fixture.calls("workflow") == [], "只清理目录时不需要触发构建", result)
    check(name, {"issue": "close", "number": 8,
                 "comment": "当前版本已没有无人维护或提示类依赖公告，告警自动关闭。"} in fixture.calls("issue"),
          "提示告警应在没有提示时关闭", result)


def scenario_quiet_day(steps: list[Step], root: Path) -> None:
    name = "什么都没变"
    fixture = make_fixture(root, audit={})
    result = run_job(steps, fixture.repository, {**fixture.env, "TRACK": "action"}, unchanged_action())
    check(name, not result.context.failed, "作业应当成功", result)
    check(name, fixture.calls("pr") == [] and fixture.calls("workflow") == [], "不应开 PR 或触发构建", result)
    check(name, fixture.calls("issue") == [], "不应动任何告警", result)


def new_release_outputs() -> dict:
    return {
        "changed": "true",
        "commit": "2" * 40,
        "current": "1" * 40,
        "reference": "v2",
        "release_id": "9",
        "lock_file": "upstream.release.lock.json",
        "label": "Release",
        "source_url": "https://github.com/olicesx/kixdns/releases/tag/v2",
    }


def scenario_release_uses_action_patchset(steps: list[Step], root: Path) -> None:
    name = "新 Release 先用 Action 轨道的补丁集"
    fixture = make_fixture(
        root,
        audit={"upstream.release.lock.json": {"3": 0, "2": 1}, "upstreams/releases/v1.json": 0},
        issues=[{"number": 9, "title": "[compat] KixDNS Release 需要适配"}],
    )
    result = run_job(steps, fixture.repository, {**fixture.env, "TRACK": "release"}, new_release_outputs())
    check(name, not result.context.failed, "作业应当成功", result)
    check(name, "Rebase overlay automatically" not in result.ran, "补丁集能直接用时不应重基", result)
    lock = json.loads(fixture.origin_file("upstream.release.lock.json") or "{}")
    check(name, lock.get("patchset") == 3 and "compatibility" not in lock and lock.get("release_tag") == "v2",
          f"应采用 Action 的补丁集并去掉旧兼容层：{lock}", result)
    check(name, fixture.origin_file("upstreams/releases/v2.json") == fixture.origin_file("upstream.release.lock.json"),
          "新版本应写入版本目录", result)
    check(name, fixture.origin_file("upstreams/releases/v1.json") is not None, "审计通过的旧 Release 应保留", result)
    created = [call for call in fixture.calls("pr") if call["pr"] == "create"]
    check(name, len(created) == 1 and created[0]["head"] == "automation/upstream-release-" + "2" * 12,
          f"PR 分支不对：{created}", result)
    check(name, fixture.calls("workflow") == [{"workflow": "build-kixdns-release.yml"}], "应触发 Release 构建", result)
    check(name, any(call["issue"] == "close" and call["number"] == 9 for call in fixture.calls("issue")),
          "适配告警应自动关闭", result)


def scenario_release_keeps_own_patchset(steps: list[Step], root: Path) -> None:
    name = "Action 补丁集不适用时回到 Release 自己的补丁集"
    fixture = make_fixture(
        root,
        audit={"upstream.release.lock.json": {"3": 1, "2": 0}, "upstreams/releases/v1.json": 0},
    )
    result = run_job(steps, fixture.repository, {**fixture.env, "TRACK": "release"}, new_release_outputs())
    check(name, not result.context.failed, "作业应当成功", result)
    lock = json.loads(fixture.origin_file("upstream.release.lock.json") or "{}")
    check(name, lock.get("patchset") == 2 and lock.get("compatibility") == "legacy"
          and lock.get("release_tag") == "v2", f"应保留 Release 自己的补丁集和兼容层：{lock}", result)


def main() -> int:
    text = WORKFLOW.read_text()
    steps = parse_steps(text)
    declared = len(re.findall(r"^      - ", text.split("\n    steps:\n", 1)[1], re.MULTILINE))
    if declared != len(steps):
        print(f"解析出 {len(steps)} 个步骤，工作流里有 {declared} 个", file=sys.stderr)
        return 1
    names = [step.name for step in steps]
    if FIRST_SIMULATED_STEP not in names:
        print(f"工作流里找不到步骤：{FIRST_SIMULATED_STEP}", file=sys.stderr)
        return 1
    scenarios = [
        scenario_refresh,
        scenario_unfixable,
        scenario_prune_only,
        scenario_quiet_day,
        scenario_release_uses_action_patchset,
        scenario_release_keeps_own_patchset,
    ]
    for scenario in scenarios:
        with tempfile.TemporaryDirectory() as directory:
            scenario(steps, Path(directory))
    if FAILURES:
        print("\n\n".join(FAILURES), file=sys.stderr)
        return 1
    print(f"每日同步工作流校验通过：{len(scenarios)} 个场景")
    return 0


if __name__ == "__main__":
    sys.exit(main())
