//! 正则照内核编译一遍 / Regexes compiled as the kernel compiles them
//!
//! 内核读配置时，域名的正则（规则和入口的 `domain_regex`、回答条件的 `request_domain_regex`）和 TXT 内容的正则
//! （`response_txt_content` 的 regex）都用 regex 库原样编译（kixdns matcher/mod.rs `domain_regex`）：不加大小写、不加锚点，状态空间
//! 和 DFA 各限 1 MB，编不出来整份配置不收。这里用同一个库、同样的上限编译，回答和内核一样：编得出为 None，编不出给内核会报的原因。
//! regex、regex-automata、regex-syntax 的版本和内核 79e8fd5 的 Cargo.lock 一样；`testdata/kernel-regex.json` 是拿内核跑出来的用例，
//! 页面（web/src/config-model/regex-check.ts）也用它测。TXT 正则另有 1000 字节的上限，页面自己查
//!
//! When the kernel reads a config, name regexes (`domain_regex` in rules and entries, `request_domain_regex` in answer conditions)
//! and TXT content regexes (`response_txt_content` in regex mode) are compiled as written with the regex library (kixdns
//! matcher/mod.rs `domain_regex`): no case folding or anchors added, the state space and the DFA each capped at 1 MB, and one that
//! does not compile makes the whole config refused. This compiles with the same library and limits and answers as the kernel does:
//! None when it compiles, otherwise the cause the kernel would give. The versions of regex, regex-automata and regex-syntax are
//! those of the kernel's Cargo.lock at 79e8fd5; `testdata/kernel-regex.json` holds cases run through the kernel, and the page
//! (web/src/config-model/regex-check.ts) is tested on it too. A TXT regex also has a 1000-byte limit, which the page checks itself

/// 内核 `domain_regex` 的上限：状态空间和 DFA 各 1 MB / The limits of the kernel's `domain_regex`: 1 MB each for the state space
/// and the DFA
const SIZE_LIMIT: usize = 1_000_000;

/// 这个正则内核编不编得出来：编得出为 None，编不出为内核报的原因 / Whether the kernel can compile this regex: None when it can,
/// otherwise the cause the kernel gives
#[must_use]
pub fn kernel_regex_problem(pattern: &str) -> Option<String> {
    regex::RegexBuilder::new(pattern)
        .size_limit(SIZE_LIMIT)
        .dfa_size_limit(SIZE_LIMIT)
        .build()
        .err()
        .map(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::kernel_regex_problem;

    #[derive(serde::Deserialize)]
    struct Case {
        pattern: String,
        error: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct Table {
        patterns: Vec<Case>,
    }

    /// 每一条都和内核的回答一样，原因一字不差 / Every answer is the kernel's, the cause word for word
    #[test]
    fn answers_as_the_kernel() {
        let table: Table =
            serde_json::from_str(include_str!("../../../testdata/kernel-regex.json")).unwrap();
        let differ: Vec<&str> = table
            .patterns
            .iter()
            .filter(|case| kernel_regex_problem(&case.pattern) != case.error)
            .map(|case| case.pattern.as_str())
            .collect();
        assert!(differ.is_empty(), "{differ:?}");
    }
}
