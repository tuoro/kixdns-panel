//! Prometheus 文本格式，只读内核 `/v1/metrics` 用到的部分：每行一个样本，注释和空行跳过，标签值按格式反转义
//! The Prometheus text format, only what the kernel's `/v1/metrics` uses: one sample per line, comments and blank
//! lines skipped, label values unescaped as the format says

/// 一个样本：名字、标签和值；时间戳用不着，不读
/// One sample: its name, labels and value; the timestamp is not needed and not read
#[derive(Debug, PartialEq)]
pub(crate) struct Sample {
    pub(crate) metric: String,
    pub(crate) labels: Labels,
    pub(crate) value: f64,
}

/// 一个样本的标签，按出现的顺序
/// A sample's labels, in the order they appear
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Labels(Vec<(String, String)>);

impl Labels {
    pub(crate) fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(label, _)| label == name)
            .map(|(_, value)| value.as_str())
    }
}

/// 文本里的每个样本；解不开的行跳过，不让一行坏数据拖垮整页
/// Every sample in the text; a line that does not parse is skipped, so one bad line cannot take the whole page down
pub(crate) fn samples(text: &str) -> impl Iterator<Item = Sample> + '_ {
    text.lines().filter_map(sample)
}

const BLANKS: [char; 2] = [' ', '\t'];

fn sample(line: &str) -> Option<Sample> {
    let line = line.trim_matches(BLANKS);
    // 空行和 `#` 开头的注释行（HELP、TYPE 也是）开头没有名字，在这里跳过
    // Blank lines and `#` comment lines (HELP and TYPE among them) do not start with a name and are skipped here
    let name_end = line
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':'))
        .unwrap_or(line.len());
    let metric = &line[..name_end];
    if !starts_a_name(metric) {
        return None;
    }
    // 名字和 `{`、`}` 和值之间可以有空白，也可以没有，和 Prometheus 的解析一样；值之后的时间戳不读
    // Blanks may or may not stand between the name and `{` and between `}` and the value, as Prometheus parses it;
    // a timestamp after the value is not read
    let rest = line[name_end..].trim_start_matches(BLANKS);
    let (labels, rest) = match rest.strip_prefix('{') {
        Some(inside) => labels(inside)?,
        None => (Labels::default(), rest),
    };
    let value = rest.split(BLANKS).find(|field| !field.is_empty())?;
    Some(Sample {
        metric: metric.to_owned(),
        labels,
        value: value.parse().ok()?,
    })
}

/// `{` 之后的标签，直到 `}`；返回标签和 `}` 之后的部分。最后一个标签后面可以多一个逗号
/// The labels after `{` up to `}`; returns them and what follows the `}`. A comma may follow the last label
fn labels(mut rest: &str) -> Option<(Labels, &str)> {
    let mut labels = Vec::new();
    loop {
        rest = rest.trim_start_matches(BLANKS);
        if let Some(after) = rest.strip_prefix('}') {
            return Some((Labels(labels), after));
        }
        let name_end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))?;
        let name = &rest[..name_end];
        if !starts_a_name(name) {
            return None;
        }
        rest = rest[name_end..]
            .trim_start_matches(BLANKS)
            .strip_prefix('=')?
            .trim_start_matches(BLANKS)
            .strip_prefix('"')?;
        let (value, after) = label_value(rest)?;
        labels.push((name.to_owned(), value));
        rest = after.trim_start_matches(BLANKS);
        match rest.strip_prefix(',') {
            Some(after) => rest = after,
            None if rest.starts_with('}') => {}
            None => return None,
        }
    }
}

/// 开头的 `"` 之后的标签值，直到没转义的 `"`。`\\`、`\"`、`\n` 换回原字符，别的反斜杠照原样留着，和
/// Prometheus 自己一样
/// A label value after its opening `"`, up to the first unescaped `"`. `\\`, `\"` and `\n` turn back into their
/// characters; any other backslash stays as written, as Prometheus itself does
fn label_value(rest: &str) -> Option<(String, &str)> {
    let mut value = String::new();
    let mut chars = rest.char_indices();
    while let Some((index, c)) = chars.next() {
        match c {
            '"' => return Some((value, &rest[index + 1..])),
            '\\' => match chars.next()?.1 {
                '\\' => value.push('\\'),
                '"' => value.push('"'),
                'n' => value.push('\n'),
                other => {
                    value.push('\\');
                    value.push(other);
                }
            },
            _ => value.push(c),
        }
    }
    None
}

/// 名字不能空，也不能以数字开头；其余的字符调用方已经限定过
/// A name is not empty and does not start with a digit; the callers have already limited the other characters
fn starts_a_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| !c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::{Labels, Sample, samples};

    fn one(line: &str) -> Option<Sample> {
        let mut found = samples(line);
        let sample = found.next();
        assert!(found.next().is_none());
        sample
    }

    fn labels(pairs: &[(&str, &str)]) -> Labels {
        Labels(
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
        )
    }

    #[test]
    fn reads_names_labels_and_values() {
        assert_eq!(
            one("kixdns_requests_total 42"),
            Some(Sample {
                metric: "kixdns_requests_total".to_owned(),
                labels: Labels::default(),
                value: 42.0,
            })
        );
        assert_eq!(
            one(r#"kixdns_upstream_latency_ms_sum{upstream="1.1.1.1:53",transport="udp"} 84.500"#),
            Some(Sample {
                metric: "kixdns_upstream_latency_ms_sum".to_owned(),
                labels: labels(&[("upstream", "1.1.1.1:53"), ("transport", "udp")]),
                value: 84.5,
            })
        );
        let empty = one("a:b_c{} 1").unwrap();
        assert_eq!(
            (empty.metric.as_str(), empty.labels),
            ("a:b_c", Labels::default())
        );
    }

    #[test]
    fn skips_comments_and_blank_lines() {
        let text = "# HELP kixdns_requests_total Requests.\n# TYPE kixdns_requests_total counter\n\n  \t\nkixdns_requests_total 3\n#kixdns_requests_total 4\n";
        let found = samples(text).collect::<Vec<_>>();
        assert_eq!(found.len(), 1);
        assert_eq!(
            (found[0].metric.as_str(), found[0].value),
            ("kixdns_requests_total", 3.0)
        );
    }

    #[test]
    fn unescapes_label_values_and_keeps_separators_inside_quotes() {
        let sample =
            one(r#"m{rule="say \"hi\", {x}=y \\ end",lines="a\nb",other="c\td\x"} 1"#).unwrap();
        assert_eq!(sample.labels.get("rule"), Some(r#"say "hi", {x}=y \ end"#));
        assert_eq!(sample.labels.get("lines"), Some("a\nb"));
        // 不认识的转义照原样留着 / An unknown escape stays as written
        assert_eq!(sample.labels.get("other"), Some(r"c\td\x"));
        assert_eq!(sample.labels.get("missing"), None);
        assert_eq!(
            one(r#"m{name="中文名"} 2"#).unwrap().labels.get("name"),
            Some("中文名")
        );
    }

    #[test]
    fn accepts_a_trailing_comma_blanks_and_a_timestamp() {
        let sample = one("  m { a = \"1\" , b=\"2\", }\t7  1700000000000  ").unwrap();
        assert_eq!(sample.labels, labels(&[("a", "1"), ("b", "2")]));
        assert!((sample.value - 7.0).abs() < f64::EPSILON);
        let tight = one("m{a=\"1\"}2").unwrap();
        assert_eq!((tight.labels.get("a"), tight.value), (Some("1"), 2.0));
    }

    #[test]
    fn reads_special_values() {
        let value = |line| one(line).unwrap().value;
        assert!(value("m NaN").is_nan());
        let infinite = |line| {
            let value = value(line);
            value.is_infinite().then_some(value.is_sign_positive())
        };
        assert_eq!(infinite("m +Inf"), Some(true));
        assert_eq!(infinite("m -Inf"), Some(false));
        assert!((value("m 1.5e3") - 1500.0).abs() < f64::EPSILON);
        assert!((value("m -0.25") + 0.25).abs() < f64::EPSILON);
    }

    #[test]
    fn skips_lines_that_do_not_parse() {
        for line in [
            "m",
            "m ",
            "m{a=\"1\"}",
            "m{a=\"1\"} two",
            "1m 2",
            "{a=\"1\"} 2",
            "m-x 2",
            "m{a=\"1 2",
            "m{a=\"1\\\"} 2",
            "m{a=1} 2",
            "m{a=\"1\" b=\"2\"} 3",
            "m{,} 2",
            "m{1a=\"1\"} 2",
            "m{a\"1\"} 2",
        ] {
            assert_eq!(one(line), None, "{line:?}");
        }
    }

    #[test]
    fn a_bad_line_leaves_the_others() {
        let found = samples("a 1\nb{x=\"open 2\nc 3\n").collect::<Vec<_>>();
        let names = found
            .iter()
            .map(|sample| sample.metric.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["a", "c"]);
    }
}
