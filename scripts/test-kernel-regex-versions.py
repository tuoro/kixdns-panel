#!/usr/bin/env python3
"""scripts/check-kernel-regex-versions.py 的用例：一样时通过；regex、regex-automata、regex-syntax 任一个不一样就失败；内核另有
一个旧版 regex-syntax（给别的库用）时，比的是 regex 用的那一版。
Cases for scripts/check-kernel-regex-versions.py: equal versions pass; any of regex, regex-automata and regex-syntax differing
fails; with an older regex-syntax in the kernel as well (used by another crate), the one regex uses is compared.
"""
import pathlib
import subprocess
import sys
import tempfile

CHECK = pathlib.Path(__file__).resolve().parent / 'check-kernel-regex-versions.py'


def lock(regex: str, automata: str, syntax: str, extra_syntax: str = '') -> str:
    syntax_dep = f'regex-syntax {syntax}' if extra_syntax else 'regex-syntax'
    text = (
        f'[[package]]\nname = "regex"\nversion = "{regex}"\n'
        f'dependencies = ["aho-corasick", "memchr", "regex-automata", "{syntax_dep}"]\n\n'
        f'[[package]]\nname = "regex-automata"\nversion = "{automata}"\ndependencies = ["{syntax_dep}"]\n\n'
        f'[[package]]\nname = "regex-syntax"\nversion = "{syntax}"\n'
    )
    if extra_syntax:
        text += f'\n[[package]]\nname = "regex-syntax"\nversion = "{extra_syntax}"\n'
    return text


def run(panel: str, kernel: str) -> int:
    with tempfile.TemporaryDirectory() as work:
        a, b = pathlib.Path(work, 'panel.lock'), pathlib.Path(work, 'kernel.lock')
        a.write_text(panel)
        b.write_text(kernel)
        return subprocess.run([sys.executable, '-I', str(CHECK), str(a), str(b)], capture_output=True, text=True).returncode


def main() -> None:
    same = lock('1.13.1', '0.4.18', '0.8.11')
    cases = [
        ('一样 / equal', same, same, 0),
        ('regex 不一样 / regex differs', same, lock('1.13.2', '0.4.18', '0.8.11'), 1),
        ('regex-automata 不一样 / regex-automata differs', same, lock('1.13.1', '0.4.19', '0.8.11'), 1),
        ('regex-syntax 不一样 / regex-syntax differs', same, lock('1.13.1', '0.4.18', '0.8.12'), 1),
        ('内核另有旧版 / an older one besides', same, lock('1.13.1', '0.4.18', '0.8.11', extra_syntax='0.6.29'), 0),
        ('另有旧版、regex 用的那版不一样 / an older one besides, regex\'s differs', same,
         lock('1.13.1', '0.4.18', '0.8.12', extra_syntax='0.6.29'), 1),
    ]
    failed = [name for name, panel, kernel, expected in cases if run(panel, kernel) != expected]
    if failed:
        sys.exit(f'没通过 / failed: {failed}')
    print(f'{len(cases)} 条用例都通过 / all {len(cases)} cases pass')


if __name__ == '__main__':
    main()
