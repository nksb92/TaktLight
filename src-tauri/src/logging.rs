use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB rolling cap

struct LoggerState {
    log_file: PathBuf,
    lock: Mutex<()>,
}

static LOGGER: OnceLock<LoggerState> = OnceLock::new();

fn format_utc_timestamp(now: SystemTime) -> String {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let sod = secs % 86_400;
    let hour = sod / 3_600;
    let minute = (sod % 3_600) / 60;
    let second = sod % 60;

    // Civil date from Unix days (Howard Hinnant algorithm)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if month <= 2 { 1 } else { 0 };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn append_line_with_rotation(log_file: &Path, max_bytes: u64, level: &str, message: &str) {
    if let Some(parent) = log_file.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(meta) = fs::metadata(log_file) {
        if meta.len() >= max_bytes {
            let rotated = log_file.with_extension("log.1");
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(log_file, &rotated);
        }
    }
    let clean = message.replace(['\r', '\n'], " ");
    let ts = format_utc_timestamp(SystemTime::now());
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_file) {
        let _ = writeln!(file, "[{ts}] [{level}] {clean}");
    }
}

pub fn init_logging(log_dir: PathBuf) {
    let log_file = log_dir.join("taktlight.log");
    let _ = LOGGER.set(LoggerState {
        log_file,
        lock: Mutex::new(()),
    });

    log_info(&format!(
        "TaktLight v{} initialized",
        env!("CARGO_PKG_VERSION")
    ));

    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let thread_name = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let payload = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "non-string panic payload".to_string()
        };
        log_error(&format!(
            "PANIC on thread '{thread_name}' at {location}: {payload}"
        ));
        prev_hook(panic_info);
    }));
}

pub fn write_log(level: &str, message: &str) {
    if let Some(state) = LOGGER.get() {
        let _guard = state.lock.lock();
        append_line_with_rotation(&state.log_file, MAX_LOG_BYTES, level, message);
    }
}

pub fn log_info(message: &str) {
    write_log("INFO", message);
}

pub fn log_warn(message: &str) {
    write_log("WARN", message);
}

pub fn log_error(message: &str) {
    write_log("ERROR", message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_timestamped_lines_and_rotates_when_exceeding_cap() {
        let dir = std::env::temp_dir().join(format!(
            "taktlight_log_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let log_file = dir.join("taktlight.log");

        append_line_with_rotation(&log_file, 128, "INFO", "first entry");
        append_line_with_rotation(
            &log_file,
            128,
            "ERROR",
            &"x".repeat(120),
        );
        // This write should trigger rotation into taktlight.log.1
        append_line_with_rotation(&log_file, 128, "WARN", "after rotation");

        let rotated = dir.join("taktlight.log.1");
        assert!(rotated.exists(), "expected rotated log file");
        let current = fs::read_to_string(&log_file).unwrap();
        assert!(current.contains("[WARN] after rotation"));
        let prev = fs::read_to_string(&rotated).unwrap();
        assert!(prev.contains("[INFO] first entry"));

        let _ = fs::remove_dir_all(&dir);
    }
}
