//! 拿内核自己的 `config::validate` 校验面板编出来的配置：从标准输入读一个 JSON 数组，每一项是 `{ "name": …, "config": … }`
//! （web/src/config-model/kernel-fixtures.test.ts 写出来的），逐份校验，有一份不收就列出名字和内核的原话，退出码 1。
//!
//! 一项还可以写面板对它怎么看（web/src/config-editor/settings-kernel-fixtures.test.ts 写出来的），内核要看得一样：
//! - `"refuses": ["settings.cache_capacity", …]`：内核要拒，拒的原因里说到的设置（每条原因开头的 `settings.…:`）正好是这几个；
//!   读不成配置（类型不对，没有逐条的原因）时只认这一项写了一个设置的；
//! - `"warns": ["settings.bootstrap", …]`：内核要收，警告里说到的设置正好是这几个。
//!
//! Checks the configs the panel compiles with the kernel's own `config::validate`: reads a JSON array from standard input, each
//! item `{ "name": …, "config": … }` (written by web/src/config-model/kernel-fixtures.test.ts), validates them one by one, and
//! when any is refused lists its name with the kernel's own words and exits with 1.
//!
//! An item may also say what the panel makes of it (written by web/src/config-editor/settings-kernel-fixtures.test.ts), and the
//! kernel has to make the same of it:
//! - `"refuses": ["settings.cache_capacity", …]`: the kernel refuses it, the settings its reasons speak of (the `settings.…:`
//!   each reason starts with) being exactly these; when it cannot be read as a config at all (a wrong type, with no reasons one
//!   by one) only an item naming one setting counts;
//! - `"warns": ["settings.bootstrap", …]`: the kernel accepts it, the settings its warnings speak of being exactly these.

use std::collections::BTreeSet;
use std::io::Read;
use std::process::ExitCode;

use serde_json::Value;

fn main() -> ExitCode {
    let mut raw = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut raw) {
        eprintln!("读不了标准输入 / cannot read standard input: {error}");
        return ExitCode::FAILURE;
    }
    let fixtures: Vec<Value> = match serde_json::from_str(&raw) {
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
    let mut differ = 0usize;
    for fixture in &fixtures {
        let name = fixture.get("name").and_then(Value::as_str).unwrap_or("?");
        if let Err(why) = check(fixture) {
            eprintln!("「{name}」/ \"{name}\": {why}");
            differ += 1;
        }
    }
    if differ > 0 {
        eprintln!(
            "{} 份配置里内核和面板看法不一样的有 {differ} 份 / the kernel and the panel differ on {differ} of {} configs",
            fixtures.len(),
            fixtures.len()
        );
        return ExitCode::FAILURE;
    }
    println!(
        "{} 份配置内核和面板看法都一样 / the kernel and the panel agree on all {} configs",
        fixtures.len(),
        fixtures.len()
    );
    ExitCode::SUCCESS
}

/// 内核对一项的看法和面板写下的对得上为 Ok，对不上时说哪里不一样 / Ok when the kernel makes of an item what the panel wrote
/// down, otherwise what differs
fn check(fixture: &Value) -> Result<(), String> {
    let config = fixture.get("config").ok_or("没有 config / has no config")?;
    let refuses = settings_named(fixture.get("refuses"));
    let warns = settings_named(fixture.get("warns"));
    match (kixdns::config::validate(&config.to_string()), refuses) {
        (Ok(report), None) => match warns {
            Some(warns) if settings_spoken_of(&report.warnings) != warns => Err(format!(
                "内核警告的设置不一样 / the kernel warns of other settings: {:?}",
                report.warnings
            )),
            _ => Ok(()),
        },
        (Ok(_), Some(refuses)) => Err(format!(
            "内核收下了，面板说不收 {refuses:?} / the kernel accepts what the panel refuses"
        )),
        (Err(error), None) => Err(format!("内核不收 / the kernel refuses it: {error:#}")),
        (Err(error), Some(refuses)) => {
            let reasons = kixdns::config::Problems::of(&error);
            let agrees = if reasons.is_empty() {
                refuses.len() == 1
            } else {
                settings_spoken_of(reasons) == refuses
            };
            if agrees {
                Ok(())
            } else {
                Err(format!(
                    "内核拒的原因不一样，面板说 {refuses:?} / the kernel refuses for other reasons than the panel's: {error:#}"
                ))
            }
        }
    }
}

/// 一项里写的设置名单，没写为 None / The list of settings an item writes, None when it writes none
fn settings_named(list: Option<&Value>) -> Option<BTreeSet<String>> {
    list.and_then(Value::as_array).map(|list| {
        list.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

/// 一串原因或警告说到的设置：开头写着 `settings.…:` 的那几个 / The settings a list of reasons or warnings speaks of: those
/// written at the start as `settings.…:`
fn settings_spoken_of(lines: &[String]) -> BTreeSet<String> {
    lines
        .iter()
        .filter_map(|line| line.split_once(':').map(|(place, _)| place))
        .filter(|place| place.starts_with("settings."))
        .map(str::to_owned)
        .collect()
}
