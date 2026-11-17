#!/usr/bin/env python3
"""npm audit，带一张逐条写明理由的例外表。

例外表里每行一个公告编号（GHSA-…），后面写为什么放行。只因为依赖了被放行的包才被报出来的包也一起放行。
剩下的漏洞到 moderate 及以上就失败。例外表里的公告不再出现（上游修好、依赖升级上去了）也失败：例外要跟着删掉，
不能一直留着。

npm audit with an allowlist where each entry states its reason.

Each line of the allowlist holds one advisory id (GHSA-…) followed by why it is allowed. A package reported only because it
depends on an allowed one is allowed with it. Anything left at moderate or above fails. An allowlisted advisory that no
longer appears (fixed upstream and updated) fails too: the entry must go with it rather than stay forever.

用法 / Usage: npm-audit.py <allowlist> [--input audit.json]
"""

import json
import subprocess
import sys

LEVELS = ["info", "low", "moderate", "high", "critical"]
FAIL_AT = LEVELS.index("moderate")


def read_allowlist(path):
    allowed = {}
    with open(path, encoding="utf-8") as lines:
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            advisory, _, reason = line.partition(" ")
            if not advisory.startswith("GHSA-") or not reason.strip():
                raise SystemExit(f"例外表里这一行要写公告编号和理由 / an allowlist line needs an advisory id and a reason: {line}")
            allowed[advisory] = reason.strip()
    return allowed


def advisory_id(via):
    return via.get("url", "").rstrip("/").rsplit("/", 1)[-1]


def remaining(vulnerabilities, allowed):
    """去掉例外以后还剩的漏洞，和例外表里实际用上的公告 / What is left after the allowlist, and the allowlisted advisories in use"""
    used = set()
    cleared = set()
    changed = True
    while changed:
        changed = False
        for name, vulnerability in vulnerabilities.items():
            if name in cleared:
                continue
            left = []
            for via in vulnerability.get("via", []):
                if isinstance(via, dict) and advisory_id(via) in allowed:
                    used.add(advisory_id(via))
                elif isinstance(via, str) and via in cleared:
                    continue
                else:
                    left.append(via)
            if not left:
                cleared.add(name)
                changed = True
    left = {
        name: vulnerability
        for name, vulnerability in vulnerabilities.items()
        if name not in cleared and LEVELS.index(vulnerability.get("severity", "info")) >= FAIL_AT
    }
    return left, used


def main(argv):
    if len(argv) not in (2, 4) or (len(argv) == 4 and argv[2] != "--input"):
        raise SystemExit(__doc__)
    allowed = read_allowlist(argv[1])
    if len(argv) == 4:
        with open(argv[3], encoding="utf-8") as source:
            report = json.load(source)
    else:
        # npm audit 有漏洞时退出码非零，结果照样在标准输出里 / npm audit exits non-zero on findings; the report is on stdout all the same
        result = subprocess.run(["npm", "audit", "--json"], capture_output=True, text=True, check=False)
        report = json.loads(result.stdout)
    left, used = remaining(report.get("vulnerabilities", {}), allowed)
    for advisory in sorted(used):
        print(f"放行 / allowed {advisory}: {allowed[advisory]}")
    failed = False
    for name, vulnerability in sorted(left.items()):
        titles = [via.get("title", "") for via in vulnerability.get("via", []) if isinstance(via, dict)]
        print(f"::error::{name} ({vulnerability.get('severity')}): {'; '.join(titles) or '依赖了有漏洞的包 / depends on a vulnerable package'}")
        failed = True
    for advisory in sorted(set(allowed) - used):
        print(f"::error::例外表里的 {advisory} 已经不再出现，把这一行删掉 / {advisory} no longer appears; remove it from the allowlist")
        failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
