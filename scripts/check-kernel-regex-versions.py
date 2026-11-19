#!/usr/bin/env python3
"""面板编辑器里的正则照内核编译（crates/panel-server/src/regex_check.rs），回答要和内核一样，就得用同一版正则库：比一比面板和
要捆绑的内核两份 Cargo.lock 里 regex、regex-automata、regex-syntax 的版本，有一个不同就失败。
The panel compiles the editor's regexes as the kernel does (crates/panel-server/src/regex_check.rs), and its answers match the
kernel's only with the same regex library: compares the versions of regex, regex-automata and regex-syntax in the panel's
Cargo.lock and in that of the kernel to be bundled, failing if any differs.

用法 / usage: python3 -I scripts/check-kernel-regex-versions.py <面板 Cargo.lock / panel> <内核 Cargo.lock / kernel>
"""
import sys
import tomllib

CRATES = ('regex', 'regex-automata', 'regex-syntax')


def regex_versions(path: str) -> dict:
    """regex 的版本，和它依赖的 regex-automata、regex-syntax 的版本 / The version of regex and of the regex-automata and
    regex-syntax it depends on"""
    with open(path, 'rb') as file:
        packages = tomllib.load(file).get('package', [])

    def only(name: str) -> dict:
        found = [p for p in packages if p['name'] == name]
        if len(found) != 1:
            sys.exit(f'{path}: 应该正好有一个 {name}，有 {len(found)} 个 / expected exactly one {name}, found {len(found)}')
        return found[0]

    regex = only('regex')
    versions = {'regex': regex['version']}
    for dependency in regex.get('dependencies', []):
        name, _, version = dependency.partition(' ')
        if name in CRATES:
            versions[name] = version or only(name)['version']
    missing = [name for name in CRATES if name not in versions]
    if missing:
        sys.exit(f'{path}: regex 没有依赖 {", ".join(missing)} / regex does not depend on {", ".join(missing)}')
    return versions


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    panel, kernel = regex_versions(sys.argv[1]), regex_versions(sys.argv[2])
    differ = [name for name in CRATES if panel[name] != kernel[name]]
    for name in CRATES:
        mark = '≠' if name in differ else '='
        print(f'{name}: 面板 / panel {panel[name]} {mark} 内核 / kernel {kernel[name]}')
    if differ:
        sys.exit('正则库的版本和内核不一样：编辑器里的正则检查会和内核答得不一样，跟着内核的 Cargo.lock 一起改 / The regex crates '
                 'differ from the kernel\'s: the editor\'s regex check would answer differently from the kernel; move them '
                 'together with the kernel\'s Cargo.lock')


if __name__ == '__main__':
    main()
