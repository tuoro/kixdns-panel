#!/usr/bin/env python3
"""重新生成 testdata/kernel-regex.json：每条正则都拿内核跑一遍，记下内核的回答。
Regenerates testdata/kernel-regex.json: every regex is run through the kernel and the kernel's answer recorded.

用法 / usage: python3 -I scripts/kernel-regex-cases.py <kixdns 内核源码目录 / kernel checkout> [表 / table]

- patterns：kind 为 domain 的放进三份最小配置（规则的 domain_regex、入口的 domain_regex、回答条件的 request_domain_regex），
  三处的结果要一样；kind 为 txt 的放进 response_txt_content 的 regex。跑内核的 config::validate，error 是内核报的原因
  （去掉前面的「compile configuration: 」），null 是内核收。
- blocklist：每条写成拦截列表合并文件里的一条 regexp:（GeoSite JSON），让内核的 GeoSiteManager 读进去，used 是内核用没用上它。
- 要加用例就往表里加一行（error、used 随便写），再跑一遍；表里的 kernel 记下用的是内核哪一版。
- patterns: a domain case goes into three minimal configs (domain_regex in a rule, domain_regex in an entry,
  request_domain_regex in an answer condition), which must agree; a txt case into response_txt_content in regex mode. The
  kernel's config::validate runs on each; error is the cause the kernel gives (without the leading 「compile configuration: 」),
  null that the kernel takes it.
- blocklist: each is written as one regexp: entry of the blocklists' merged file (GeoSite JSON) and read by the kernel's
  GeoSiteManager; used says whether the kernel kept it.
- To add a case, add a line to the table (any error or used) and run this again; kernel in the table records which kernel ran.

这里在临时目录里编一个小程序（依赖内核源码，用内核自己的 Cargo.lock，正则库的版本和内核一样），要 cargo；CARGO_TARGET_DIR 照用。
This builds a small program in a temporary directory (depending on the kernel source, with the kernel's own Cargo.lock so the
regex crates are the kernel's), which takes cargo; CARGO_TARGET_DIR is honoured.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

VALIDATOR = r'''
use std::io::Read;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let out: Vec<serde_json::Value> = match mode.as_str() {
        "validate" => serde_json::from_str::<Vec<serde_json::Value>>(&raw)
            .unwrap()
            .iter()
            .map(|config| match kixdns::config::validate(&config.to_string()) {
                Ok(_) => serde_json::Value::Null,
                Err(error) => format!("{error:#}").into(),
            })
            .collect(),
        "blocklist" => {
            let patterns: Vec<String> = serde_json::from_str(&raw).unwrap();
            let entries: Vec<serde_json::Value> = patterns
                .iter()
                .enumerate()
                .map(|(i, p)| serde_json::json!({ "tag": format!("t{i}"), "domains": [format!("regexp:{p}")] }))
                .collect();
            let mut manager = kixdns::matcher::geosite::GeoSiteManager::new();
            manager
                .load_from_v2ray_string(&serde_json::json!({ "entries": entries }).to_string())
                .unwrap();
            (0..patterns.len())
                .map(|i| manager.get_tag_matchers(&format!("t{i}")).is_some_and(|m| !m.is_empty()).into())
                .collect()
        }
        _ => panic!("usage: validator validate|blocklist"),
    };
    println!("{}", serde_json::Value::from(out));
}
'''

PREFIX = 'compile configuration: '


def build_validator(kernel: pathlib.Path, work: pathlib.Path) -> pathlib.Path:
    (work / 'src').mkdir()
    (work / 'src' / 'main.rs').write_text(VALIDATOR)
    (work / 'Cargo.toml').write_text(
        '[package]\nname = "kernel-regex-validator"\nversion = "0.1.0"\nedition = "2024"\n\n'
        f'[dependencies]\nkixdns = {{ path = {json.dumps(str(kernel))} }}\nserde_json = "1"\n\n[workspace]\n')
    shutil.copy(kernel / 'Cargo.lock', work / 'Cargo.lock')
    target = pathlib.Path(os.environ.get('CARGO_TARGET_DIR', work / 'target'))
    subprocess.run(['cargo', 'build', '--release', '--quiet'], cwd=work, check=True)
    return target / 'release' / 'kernel-regex-validator'


def run(validator: pathlib.Path, mode: str, payload) -> list:
    result = subprocess.run([str(validator), mode], input=json.dumps(payload), capture_output=True, text=True,
                            check=True, timeout=600)
    return json.loads(result.stdout)


def config(rule: dict, entry_matchers: list) -> dict:
    return {
        'version': '1.0',
        'settings': {'default_upstream': '1.1.1.1:53'},
        'pipeline_select': [{'pipeline': 'main', 'matchers': entry_matchers}],
        'pipelines': [{'id': 'main', 'rules': [rule]}],
    }


def configs_for(kind: str, pattern: str) -> list:
    forward = [{'type': 'forward', 'upstream': '1.1.1.1:53'}]
    if kind == 'txt':
        return [config({'name': 'r', 'matchers': [], 'actions': forward,
                        'response_matchers': [{'type': 'response_txt_content', 'mode': 'regex', 'value': pattern}],
                        'response_actions_on_match': [{'type': 'deny'}]}, [])]
    regex = {'type': 'domain_regex', 'value': pattern}
    return [
        config({'name': 'r', 'matchers': [regex], 'actions': [{'type': 'deny'}]}, []),
        config({'name': 'r', 'matchers': [], 'actions': [{'type': 'deny'}]}, [regex]),
        config({'name': 'r', 'matchers': [], 'actions': forward,
                'response_matchers': [{'type': 'request_domain_regex', 'value': pattern}],
                'response_actions_on_match': [{'type': 'deny'}]}, []),
    ]


def main() -> None:
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    kernel = pathlib.Path(sys.argv[1]).resolve()
    table_path = pathlib.Path(sys.argv[2] if len(sys.argv) == 3 else
                              pathlib.Path(__file__).resolve().parent.parent / 'testdata' / 'kernel-regex.json')
    table = json.loads(table_path.read_text(encoding='utf-8'))
    commit = subprocess.run(['git', '-C', str(kernel), 'rev-parse', '--short=7', 'HEAD'], capture_output=True, text=True,
                            check=True).stdout.strip()
    with tempfile.TemporaryDirectory() as work:
        validator = build_validator(kernel, pathlib.Path(work))
        groups = [configs_for(case['kind'], case['pattern']) for case in table['patterns']]
        answers = run(validator, 'validate', [c for group in groups for c in group])
        used = run(validator, 'blocklist', [case['pattern'] for case in table['blocklist']])
    at = 0
    for case, group in zip(table['patterns'], groups):
        found = answers[at:at + len(group)]
        at += len(group)
        if len(set(map(json.dumps, found))) != 1:
            sys.exit(f'{case["kind"]} {case["pattern"]!r}: the places disagree: {found}')
        error = found[0]
        if error is not None and not error.startswith(PREFIX):
            sys.exit(f'{case["kind"]} {case["pattern"]!r}: refused outside compiling: {error}')
        case['error'] = None if error is None else error[len(PREFIX):]
    for case, kept in zip(table['blocklist'], used):
        case['used'] = kept
    table['kernel'] = commit
    lines = ['{']
    for key in table:
        if key in ('patterns', 'blocklist'):
            continue
        lines.append(f'  {json.dumps(key)}: {json.dumps(table[key], ensure_ascii=False)},')
    for key in ('patterns', 'blocklist'):
        rows = [json.dumps(row, ensure_ascii=False, separators=(',', ':')) for row in table[key]]
        lines.append(f'  {json.dumps(key)}: [')
        lines.append(',\n'.join(f'    {row}' for row in rows))
        lines.append('  ],' if key == 'patterns' else '  ]')
    lines.append('}')
    table_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'{len(table["patterns"])} patterns, {len(table["blocklist"])} blocklist entries, kernel {commit}')


if __name__ == '__main__':
    main()
