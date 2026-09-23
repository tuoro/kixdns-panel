//! 上游健康和响应速度看最近一小时，而不是 `KixDNS` 启动以来的累计。
//!
//! 内核的计数从进程启动起一直累加：几天前的一次抖动会一直拖着成功率和平均耗时，现在
//! 真出了问题也要很久才显出来。面板每分钟采样一次这些计数，留在内存里；取概览时拿当前
//! 值减去一小时内最早的那次采样，得到最近一段时间的计数。不落库：面板重启后丢掉的只是
//! 几分钟的窗口，页面那几分钟退回累计值。
//!
//! Upstream health and response speed look at the last hour rather than everything
//! since `KixDNS` started. The kernel's counters grow for the life of the process, so
//! an outage days ago keeps dragging the success rate and the average latency, and a
//! problem now takes a long time to show. The panel samples those counters every
//! minute and keeps them in memory; the overview subtracts the earliest sample within
//! the hour from the current values. Nothing is stored: a panel restart only loses a
//! few minutes of window, during which the page falls back to the cumulative counts.

use std::collections::{HashMap, VecDeque};

use crate::control::{MetricsSnapshot, RequestLatency, UpstreamCount, UpstreamTally};

/// 窗口长度。 / The window length.
pub const RECENT_WINDOW_SECONDS: i64 = 60 * 60;

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

/// 端到端耗时两次采样之差。 / The end-to-end latency between two samples.
fn latency_since(current: &RequestLatency, baseline: &RequestLatency) -> RequestLatency {
    let samples = current.samples.saturating_sub(baseline.samples);
    let sum_ms = (current.sum_ms - baseline.sum_ms).max(0.0);
    RequestLatency {
        samples,
        #[allow(clippy::cast_precision_loss)]
        avg_ms: if samples > 0 {
            sum_ms / samples as f64
        } else {
            0.0
        },
        within_10ms: current.within_10ms.saturating_sub(baseline.within_10ms),
        within_100ms: current.within_100ms.saturating_sub(baseline.within_100ms),
        within_1s: current.within_1s.saturating_sub(baseline.within_1s),
        sum_ms,
    }
}

#[derive(Debug)]
struct Sample {
    captured_at: i64,
    kernel_started_at: i64,
    upstreams: HashMap<(String, String), Counters>,
    request_latency: RequestLatency,
}

/// 最近一小时的计数采样。 / Counter samples from the last hour.
#[derive(Debug, Default)]
pub struct RecentHistory {
    samples: VecDeque<Sample>,
}

impl RecentHistory {
    /// 记下一次采样，丢掉已经出窗口的旧采样。
    /// Records a sample and drops the ones that have left the window.
    pub fn record(&mut self, captured_at: i64, kernel_started_at: i64, metrics: &MetricsSnapshot) {
        self.samples.push_back(Sample {
            captured_at,
            kernel_started_at,
            upstreams: metrics
                .upstreams
                .iter()
                .map(|upstream| {
                    (
                        (upstream.upstream.clone(), upstream.transport.clone()),
                        Counters::of(upstream),
                    )
                })
                .collect(),
            request_latency: metrics.request_latency.clone(),
        });
        while self
            .samples
            .front()
            .is_some_and(|sample| sample.captured_at < captured_at - RECENT_WINDOW_SECONDS)
        {
            self.samples.pop_front();
        }
    }

    /// 给快照填上最近一段时间的计数：每个上游的 `recent` 和 `request_latency_recent`。
    ///
    /// `KixDNS` 在一小时内重启过的话，它启动以来的计数本身就都在窗口里，直接用；否则拿
    /// 同一个进程在一小时内最早的那次采样做基准。两者都没有时不填，页面退回累计值。
    ///
    /// Fills in the recent counts: each upstream's `recent` and
    /// `request_latency_recent`. If `KixDNS` restarted within the hour, everything it
    /// counted since is already inside the window and is used as is; otherwise the
    /// earliest sample of the same process within the hour is the baseline. With
    /// neither, nothing is filled in and the page uses the totals.
    pub fn attach(&self, snapshot: &mut MetricsSnapshot, now: i64, kernel_started_at: i64) {
        let window_start = now - RECENT_WINDOW_SECONDS;
        let (start, baseline) = if (window_start..=now).contains(&kernel_started_at) {
            (kernel_started_at, None)
        } else if let Some(sample) = self.samples.iter().find(|sample| {
            sample.kernel_started_at == kernel_started_at
                && (window_start..now).contains(&sample.captured_at)
        }) {
            (sample.captured_at, Some(sample))
        } else {
            snapshot.recent_window_seconds = None;
            return;
        };
        snapshot.recent_window_seconds = u64::try_from(now - start).ok();
        for upstream in &mut snapshot.upstreams {
            let key = (upstream.upstream.clone(), upstream.transport.clone());
            let base = baseline
                .and_then(|sample| sample.upstreams.get(&key))
                .copied()
                .unwrap_or_default();
            upstream.recent = Some(Counters::of(upstream).since(base));
        }
        let latency_base = baseline
            .map(|sample| sample.request_latency.clone())
            .unwrap_or_default();
        snapshot.request_latency_recent =
            Some(latency_since(&snapshot.request_latency, &latency_base));
    }
}

#[cfg(test)]
mod tests {
    use super::{RECENT_WINDOW_SECONDS, RecentHistory};
    use crate::control::{MetricsSnapshot, RequestLatency, UpstreamCount, UpstreamTally};

    const NOW: i64 = 1_800_000_000;
    const LONG_AGO: i64 = NOW - 3 * RECENT_WINDOW_SECONDS;

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

    fn latency(samples: u64, sum_ms: f64, within: [u64; 3]) -> RequestLatency {
        RequestLatency {
            samples,
            #[allow(clippy::cast_precision_loss)]
            avg_ms: sum_ms / samples as f64,
            within_10ms: within[0],
            within_100ms: within[1],
            within_1s: within[2],
            sum_ms,
        }
    }

    fn snapshot(upstreams: Vec<UpstreamCount>) -> MetricsSnapshot {
        MetricsSnapshot {
            upstreams,
            ..MetricsSnapshot::default()
        }
    }

    fn with_latency(request_latency: RequestLatency) -> MetricsSnapshot {
        MetricsSnapshot {
            request_latency,
            ..MetricsSnapshot::default()
        }
    }

    #[test]
    fn subtracts_the_earliest_sample_within_the_hour() {
        let mut history = RecentHistory::default();
        // 出了窗口的采样不能当基准。 / A sample outside the window is never the baseline.
        history.record(
            NOW - 3_700,
            LONG_AGO,
            &snapshot(vec![upstream("a", 10, 90, 9_000.0)]),
        );
        history.record(
            NOW - 3_500,
            LONG_AGO,
            &snapshot(vec![upstream("a", 100, 50, 10_000.0)]),
        );
        history.record(
            NOW - 1_800,
            LONG_AGO,
            &snapshot(vec![upstream("a", 500, 55, 20_000.0)]),
        );
        let mut current = snapshot(vec![upstream("a", 1_100, 60, 30_000.0)]);

        history.attach(&mut current, NOW, LONG_AGO);

        assert_eq!(current.recent_window_seconds, Some(3_500));
        let recent = current.upstreams[0].recent.clone().unwrap();
        assert_eq!(recent.success, 1_000);
        assert_eq!(recent.errors, 10);
        assert_eq!(recent.attempts, 1_010);
        // (30000 - 10000) / (1164 - 154)
        let average = recent.avg_latency_ms.unwrap();
        assert!((average - 20_000.0 / 1_010.0).abs() < 1e-9, "{average}");
    }

    #[test]
    fn request_latency_uses_the_same_baseline() {
        let mut history = RecentHistory::default();
        // 几天前的慢请求都在基准里，最近一小时只剩 1000 次快请求。
        // The slow requests from days ago are all in the baseline; the last hour holds
        // only 1000 fast ones.
        history.record(
            NOW - 3_700,
            LONG_AGO,
            &with_latency(latency(10, 50_000.0, [0, 0, 0])),
        );
        history.record(
            NOW - 3_500,
            LONG_AGO,
            &with_latency(latency(5_000, 900_000.0, [3_000, 4_000, 4_500])),
        );
        let mut current = with_latency(latency(6_000, 905_000.0, [3_900, 4_990, 5_500]));

        history.attach(&mut current, NOW, LONG_AGO);

        assert_eq!(current.recent_window_seconds, Some(3_500));
        let recent = current.request_latency_recent.unwrap();
        assert_eq!(recent.samples, 1_000);
        assert!((recent.avg_ms - 5.0).abs() < 1e-9, "{}", recent.avg_ms);
        assert_eq!(
            (recent.within_10ms, recent.within_100ms, recent.within_1s),
            (900, 990, 1_000)
        );
        // 累计值原样保留。 / The totals are left as they were.
        assert_eq!(current.request_latency.samples, 6_000);
    }

    #[test]
    fn a_restart_within_the_hour_counts_everything_since() {
        let mut history = RecentHistory::default();
        history.record(
            NOW - 2_000,
            LONG_AGO,
            &snapshot(vec![upstream("a", 9_000, 900, 1.0)]),
        );
        let started = NOW - 1_200;
        let mut current = snapshot(vec![upstream("a", 300, 3, 600.0)]);
        current.request_latency = latency(40, 400.0, [30, 39, 40]);

        history.attach(&mut current, NOW, started);

        assert_eq!(current.recent_window_seconds, Some(1_200));
        let recent = current.upstreams[0].recent.clone().unwrap();
        assert_eq!((recent.success, recent.errors), (300, 3));
        let latency = current.request_latency_recent.unwrap();
        assert_eq!((latency.samples, latency.within_10ms), (40, 30));
        assert!((latency.avg_ms - 10.0).abs() < 1e-9);
    }

    #[test]
    fn without_a_baseline_nothing_is_filled_in() {
        let history = RecentHistory::default();
        let mut current = snapshot(vec![upstream("a", 300, 3, 600.0)]);

        history.attach(&mut current, NOW, LONG_AGO);

        assert_eq!(current.recent_window_seconds, None);
        assert!(current.upstreams[0].recent.is_none());
        assert!(current.request_latency_recent.is_none());
    }

    #[test]
    fn a_new_upstream_counts_from_zero() {
        let mut history = RecentHistory::default();
        history.record(
            NOW - 600,
            LONG_AGO,
            &snapshot(vec![upstream("a", 10, 0, 100.0)]),
        );
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
        let mut history = RecentHistory::default();
        for minutes in 0..=90 {
            history.record(
                NOW - 5_400 + minutes * 60,
                LONG_AGO,
                &MetricsSnapshot::default(),
            );
        }
        assert!(
            history
                .samples
                .iter()
                .all(|sample| sample.captured_at >= NOW - RECENT_WINDOW_SECONDS)
        );
        assert_eq!(history.samples.len(), 61);
    }
}
