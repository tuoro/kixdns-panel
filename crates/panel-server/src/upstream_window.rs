//! 上游健康看最近一小时，而不是 `KixDNS` 启动以来的累计。
//!
//! 内核的上游计数从进程启动起一直累加：几天前的一次抖动会一直拖着成功率，现在真出了
//! 问题也要很久才显出来。面板每分钟采样一次这些计数，留在内存里；取概览时拿当前值减去
//! 一小时内最早的那次采样，得到最近一段时间的计数。不落库：面板重启后丢掉的只是几分钟
//! 的窗口，页面那几分钟退回累计值。
//!
//! Upstream health looks at the last hour rather than everything since `KixDNS`
//! started. The kernel's upstream counters grow for the life of the process, so an
//! outage days ago keeps dragging the success rate down and a problem now takes a
//! long time to show. The panel samples those counters every minute and keeps them in
//! memory; the overview subtracts the earliest sample within the hour from the current
//! values. Nothing is stored: a panel restart only loses a few minutes of window,
//! during which the page falls back to the cumulative counts.

use std::collections::{HashMap, VecDeque};

use crate::control::{MetricsSnapshot, UpstreamCount, UpstreamTally};

/// 窗口长度。 / The window length.
pub const UPSTREAM_WINDOW_SECONDS: i64 = 60 * 60;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Counters {
    attempts: u64,
    success: u64,
    errors: u64,
    rejected: u64,
    aborted: u64,
    tcp_fallbacks: u64,
    latency_sum_ms: f64,
    latency_samples: u64,
}

impl Counters {
    fn of(upstream: &UpstreamCount) -> Self {
        Self {
            attempts: upstream.attempts,
            success: upstream.success,
            errors: upstream.errors,
            rejected: upstream.rejected,
            aborted: upstream.aborted,
            tcp_fallbacks: upstream.tcp_fallbacks,
            latency_sum_ms: upstream.latency_sum_ms,
            latency_samples: upstream.latency_samples,
        }
    }

    fn since(self, baseline: Self) -> UpstreamTally {
        let samples = self
            .latency_samples
            .saturating_sub(baseline.latency_samples);
        let sum = (self.latency_sum_ms - baseline.latency_sum_ms).max(0.0);
        UpstreamTally {
            attempts: self.attempts.saturating_sub(baseline.attempts),
            success: self.success.saturating_sub(baseline.success),
            errors: self.errors.saturating_sub(baseline.errors),
            rejected: self.rejected.saturating_sub(baseline.rejected),
            aborted: self.aborted.saturating_sub(baseline.aborted),
            tcp_fallbacks: self.tcp_fallbacks.saturating_sub(baseline.tcp_fallbacks),
            #[allow(clippy::cast_precision_loss)]
            avg_latency_ms: (samples > 0).then(|| sum / samples as f64),
        }
    }
}

#[derive(Debug)]
struct Sample {
    captured_at: i64,
    kernel_started_at: i64,
    counters: HashMap<(String, String), Counters>,
}

/// 最近一小时的上游采样。 / Upstream samples from the last hour.
#[derive(Debug, Default)]
pub struct UpstreamHistory {
    samples: VecDeque<Sample>,
}

impl UpstreamHistory {
    /// 记下一次采样，丢掉已经出窗口的旧采样。
    /// Records a sample and drops the ones that have left the window.
    pub fn record(
        &mut self,
        captured_at: i64,
        kernel_started_at: i64,
        upstreams: &[UpstreamCount],
    ) {
        self.samples.push_back(Sample {
            captured_at,
            kernel_started_at,
            counters: upstreams
                .iter()
                .map(|upstream| {
                    (
                        (upstream.upstream.clone(), upstream.transport.clone()),
                        Counters::of(upstream),
                    )
                })
                .collect(),
        });
        while self
            .samples
            .front()
            .is_some_and(|sample| sample.captured_at < captured_at - UPSTREAM_WINDOW_SECONDS)
        {
            self.samples.pop_front();
        }
    }

    /// 给快照里的每个上游填上最近一段时间的计数。
    ///
    /// `KixDNS` 在一小时内重启过的话，它启动以来的计数本身就都在窗口里，直接用；否则拿
    /// 同一个进程在一小时内最早的那次采样做基准。两者都没有时不填，页面退回累计值。
    ///
    /// Fills in each upstream's recent counts. If `KixDNS` restarted within the hour,
    /// everything it counted since is already inside the window and is used as is;
    /// otherwise the earliest sample of the same process within the hour is the
    /// baseline. With neither, nothing is filled in and the page uses the totals.
    pub fn attach(&self, snapshot: &mut MetricsSnapshot, now: i64, kernel_started_at: i64) {
        let window_start = now - UPSTREAM_WINDOW_SECONDS;
        let (start, baseline) = if (window_start..=now).contains(&kernel_started_at) {
            (kernel_started_at, None)
        } else if let Some(sample) = self.samples.iter().find(|sample| {
            sample.kernel_started_at == kernel_started_at
                && (window_start..now).contains(&sample.captured_at)
        }) {
            (sample.captured_at, Some(&sample.counters))
        } else {
            snapshot.upstream_window_seconds = None;
            return;
        };
        snapshot.upstream_window_seconds = u64::try_from(now - start).ok();
        for upstream in &mut snapshot.upstreams {
            let key = (upstream.upstream.clone(), upstream.transport.clone());
            let base = baseline
                .and_then(|counters| counters.get(&key))
                .copied()
                .unwrap_or_default();
            upstream.recent = Some(Counters::of(upstream).since(base));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{UPSTREAM_WINDOW_SECONDS, UpstreamHistory};
    use crate::control::{MetricsSnapshot, UpstreamCount, UpstreamTally};

    const NOW: i64 = 1_800_000_000;
    const LONG_AGO: i64 = NOW - 3 * UPSTREAM_WINDOW_SECONDS;

    fn upstream(name: &str, success: u64, errors: u64, latency_sum_ms: f64) -> UpstreamCount {
        UpstreamCount {
            upstream: name.to_owned(),
            transport: "udp".to_owned(),
            attempts: success + errors + 10,
            success,
            errors,
            rejected: 4,
            aborted: 6,
            tcp_fallbacks: 1,
            latency_sum_ms,
            latency_samples: success + errors + 4,
            ..UpstreamCount::default()
        }
    }

    fn snapshot(upstreams: Vec<UpstreamCount>) -> MetricsSnapshot {
        MetricsSnapshot {
            upstreams,
            ..MetricsSnapshot::default()
        }
    }

    #[test]
    fn subtracts_the_earliest_sample_within_the_hour() {
        let mut history = UpstreamHistory::default();
        // 出了窗口的采样不能当基准。 / A sample outside the window is never the baseline.
        history.record(NOW - 3_700, LONG_AGO, &[upstream("a", 10, 90, 9_000.0)]);
        history.record(NOW - 3_500, LONG_AGO, &[upstream("a", 100, 50, 10_000.0)]);
        history.record(NOW - 1_800, LONG_AGO, &[upstream("a", 500, 55, 20_000.0)]);
        let mut current = snapshot(vec![upstream("a", 1_100, 60, 30_000.0)]);

        history.attach(&mut current, NOW, LONG_AGO);

        assert_eq!(current.upstream_window_seconds, Some(3_500));
        let recent = current.upstreams[0].recent.clone().unwrap();
        assert_eq!(recent.success, 1_000);
        assert_eq!(recent.errors, 10);
        assert_eq!(recent.attempts, 1_010);
        // (30000 - 10000) / (1164 - 154)
        let average = recent.avg_latency_ms.unwrap();
        assert!((average - 20_000.0 / 1_010.0).abs() < 1e-9, "{average}");
    }

    #[test]
    fn a_restart_within_the_hour_counts_everything_since() {
        let mut history = UpstreamHistory::default();
        history.record(NOW - 2_000, LONG_AGO, &[upstream("a", 9_000, 900, 1.0)]);
        let started = NOW - 1_200;
        let mut current = snapshot(vec![upstream("a", 300, 3, 600.0)]);

        history.attach(&mut current, NOW, started);

        assert_eq!(current.upstream_window_seconds, Some(1_200));
        let recent = current.upstreams[0].recent.clone().unwrap();
        assert_eq!((recent.success, recent.errors), (300, 3));
    }

    #[test]
    fn without_a_baseline_nothing_is_filled_in() {
        let history = UpstreamHistory::default();
        let mut current = snapshot(vec![upstream("a", 300, 3, 600.0)]);

        history.attach(&mut current, NOW, LONG_AGO);

        assert_eq!(current.upstream_window_seconds, None);
        assert!(current.upstreams[0].recent.is_none());
    }

    #[test]
    fn a_new_upstream_counts_from_zero() {
        let mut history = UpstreamHistory::default();
        history.record(NOW - 600, LONG_AGO, &[upstream("a", 10, 0, 100.0)]);
        let mut current = snapshot(vec![upstream("a", 20, 0, 200.0), upstream("b", 7, 1, 80.0)]);

        history.attach(&mut current, NOW, LONG_AGO);

        let fresh = current.upstreams[1].recent.clone().unwrap();
        assert_eq!(
            fresh,
            UpstreamTally {
                attempts: 18,
                success: 7,
                errors: 1,
                rejected: 4,
                aborted: 6,
                tcp_fallbacks: 1,
                avg_latency_ms: Some(80.0 / 12.0),
            }
        );
    }

    #[test]
    fn keeps_only_samples_inside_the_window() {
        let mut history = UpstreamHistory::default();
        for minutes in 0..=90 {
            history.record(NOW - 5_400 + minutes * 60, LONG_AGO, &[]);
        }
        assert!(
            history
                .samples
                .iter()
                .all(|sample| sample.captured_at >= NOW - UPSTREAM_WINDOW_SECONDS)
        );
        assert_eq!(history.samples.len(), 61);
    }
}
