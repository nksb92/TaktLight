use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use parking_lot::RwLock;
use tokio::sync::watch;

use taktlight_engine::engine::runner::{
    run_realtime_loop_with_sink, EngineConfig, EngineTelemetrySnapshot,
};
use taktlight_engine::protocol::sink::MockPacketSink;
use taktlight_engine::state::plan::RenderPlan;
use taktlight_engine::state::runtime::RuntimeControl;

fn parse_duration_sec() -> u64 {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--duration-sec" {
            if let Some(val) = args.next() {
                if let Ok(parsed) = val.parse::<u64>() {
                    return parsed.max(1);
                }
            }
        }
    }
    600
}

fn main() {
    let duration_sec = parse_duration_sec();
    println!(
        "Starting TaktLight 44 Hz timing benchmark for {} seconds...",
        duration_sec
    );

    let config = EngineConfig::default();
    let plan = Arc::new(ArcSwap::from_pointee(RenderPlan::default_studio_plan()));
    let runtime = Arc::new(ArcSwap::from_pointee(RuntimeControl::new()));
    let (frame_tx, _frame_rx) = watch::channel(Vec::new());
    let telemetry = Arc::new(RwLock::new(EngineTelemetrySnapshot::default()));
    let (_cmd_tx, cmd_rx) = mpsc::channel();
    let sink = Box::new(MockPacketSink::new());

    let stats = run_realtime_loop_with_sink(
        config,
        plan,
        runtime,
        frame_tx,
        telemetry,
        sink,
        cmd_rx,
        Some(Duration::from_secs(duration_sec)),
    );

    println!(
        "Benchmark complete: samples={} mean_us={:.2} max_jitter_us={:.2} p99_jitter_us={:.2} dropped_frames={}",
        stats.sample_count,
        stats.mean_us,
        stats.max_jitter_us,
        stats.p99_jitter_us,
        stats.dropped_frames
    );

    if stats.p99_jitter_us >= 500.0 || stats.dropped_frames > 0 {
        eprintln!(
            "FAIL: Timing SLA violated (p99_jitter_us={:.2}, dropped_frames={})",
            stats.p99_jitter_us, stats.dropped_frames
        );
        std::process::exit(1);
    }

    println!("PASS: p99_jitter_us < 500 us and dropped_frames == 0");
}
