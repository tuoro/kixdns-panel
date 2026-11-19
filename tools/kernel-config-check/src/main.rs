//! 拿内核自己的 `config::validate` 校验面板编出来的配置：从标准输入读一个 JSON 数组，每一项是 `{ "name": …, "config": … }`
//! （web/src/config-model/kernel-fixtures.test.ts 写出来的），逐份校验，有一份不收就列出名字和内核的原话，退出码 1。
//!
//! Checks the configs the panel compiles with the kernel's own `config::validate`: reads a JSON array from standard input, each
//! item `{ "name": …, "config": … }` (written by web/src/config-model/kernel-fixtures.test.ts), validates them one by one, and
//! when any is refused lists its name with the kernel's own words and exits with 1.

use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut raw = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut raw) {
        eprintln!("读不了标准输入 / cannot read standard input: {error}");
        return ExitCode::FAILURE;
    }
    let fixtures: Vec<serde_json::Value> = match serde_json::from_str(&raw) {
        Ok(list) => list,
        Err(error) => {
            eprintln!("标准输入不是 JSON 数组 / standard input is not a JSON array: {error}");
            return ExitCode::FAILURE;
        }
    };
    if fixtures.is_empty() {
        eprintln!("没有要校验的配置 / no configs to check");
        return ExitCode::FAILURE;
    }
    let mut refused = 0usize;
    for fixture in &fixtures {
        let name = fixture.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let Some(config) = fixture.get("config") else {
            eprintln!("「{name}」没有 config / \"{name}\" has no config");
            refused += 1;
            continue;
        };
        if let Err(error) = kixdns::config::validate(&config.to_string()) {
            eprintln!("内核不收「{name}」/ the kernel refuses \"{name}\": {error:#}");
            refused += 1;
        }
    }
    if refused > 0 {
        eprintln!(
            "{} 份配置里内核不收 {refused} 份 / the kernel refuses {refused} of {} configs",
            fixtures.len(),
            fixtures.len()
        );
        return ExitCode::FAILURE;
    }
    println!(
        "{} 份配置内核都收 / the kernel accepts all {} configs",
        fixtures.len(),
        fixtures.len()
    );
    ExitCode::SUCCESS
}
