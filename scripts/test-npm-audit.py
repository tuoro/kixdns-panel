#!/usr/bin/env python3
"""npm-audit.py 的例外表：放行写明的公告和只因它被报出来的包，其余照样失败，用不上的例外也失败。
The allowlist of npm-audit.py: the named advisory and packages reported only through it pass, everything else still fails,
and an entry no longer used fails too."""

import json
import pathlib
import subprocess
import sys
import tempfile

SCRIPT = pathlib.Path(__file__).with_name("npm-audit.py")


def advisory(ghsa, severity="high"):
    return {"source": 1, "name": "x", "title": f"title of {ghsa}", "url": f"https://github.com/advisories/{ghsa}", "severity": severity}


def run(vulnerabilities, allowlist):
    with tempfile.TemporaryDirectory() as work:
        report = pathlib.Path(work, "audit.json")
        report.write_text(json.dumps({"vulnerabilities": vulnerabilities}), encoding="utf-8")
        allow = pathlib.Path(work, "allow.txt")
        allow.write_text(allowlist, encoding="utf-8")
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), str(allow), "--input", str(report)], capture_output=True, text=True, check=False)
        return result.returncode, result.stdout + result.stderr


def expect(condition, message, output):
    if not condition:
        print(f"断言失败 / assertion failed: {message}\n{output}", file=sys.stderr)
        sys.exit(1)


# 放行的公告，和只因它被报出来的一串包（vue-tsc → @vue/language-core → picomatch）
# The allowed advisory and a chain of packages reported only through it
chain = {
    "picomatch": {"severity": "high", "via": [advisory("GHSA-aaaa")]},
    "@vue/language-core": {"severity": "high", "via": ["picomatch"]},
    "vue-tsc": {"severity": "high", "via": ["@vue/language-core"]},
}
code, output = run(chain, "GHSA-aaaa 只在构建工具里，没有修复版本\n")
expect(code == 0, "放行的公告连同只因它被报出来的包都应通过", output)
expect("放行 / allowed GHSA-aaaa" in output, "应说出放行了哪一条", output)

# 同一个包另外还有一条没放行的公告：照样失败 / The same package has another advisory not allowed: still fails
both = {"picomatch": {"severity": "high", "via": [advisory("GHSA-aaaa"), advisory("GHSA-bbbb")]}, "vue-tsc": {"severity": "high", "via": ["picomatch"]}}
code, output = run(both, "GHSA-aaaa 理由\n")
expect(code == 1 and "picomatch" in output and "vue-tsc" in output, "没放行的公告和依赖它的包都应失败", output)

# 别的包的漏洞：照样失败；low 不算 / Another package's vulnerability still fails; low does not count
other = dict(chain, lodash={"severity": "moderate", "via": [advisory("GHSA-cccc", "moderate")]}, tiny={"severity": "low", "via": [advisory("GHSA-dddd", "low")]})
code, output = run(other, "GHSA-aaaa 理由\n")
expect(code == 1 and "lodash" in output and "tiny" not in output, "moderate 以上的其他漏洞应失败，low 不算", output)

# 例外用不上了（上游修好了）：失败，提示删掉 / An entry no longer used (fixed upstream) fails and says to remove it
code, output = run({}, "GHSA-aaaa 理由\n")
expect(code == 1 and "GHSA-aaaa" in output, "用不上的例外应失败", output)

# 例外要写理由 / An entry needs a reason
code, output = run(chain, "GHSA-aaaa\n")
expect(code == 1, "没写理由的例外应拒绝", output)

print("npm 审计例外表检查通过。")
