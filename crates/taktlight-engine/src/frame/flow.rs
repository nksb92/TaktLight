use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{watch, Notify};

#[derive(Debug, Clone)]
pub struct FrameCreditGate {
    ack_frame: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Default for FrameCreditGate {
    fn default() -> Self {
        Self::new(true)
    }
}

impl FrameCreditGate {
    pub fn new(initial_credit: bool) -> Self {
        Self {
            ack_frame: Arc::new(AtomicBool::new(initial_credit)),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn grant_credit(&self) {
        self.ack_frame.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn try_consume_credit(&self) -> bool {
        self.ack_frame.swap(false, Ordering::AcqRel)
    }

    pub fn has_credit(&self) -> bool {
        self.ack_frame.load(Ordering::Acquire)
    }

    pub async fn wait_for_frame(&self, rx: &mut watch::Receiver<Vec<u8>>) -> Option<Vec<u8>> {
        loop {
            if !self.has_credit() {
                self.notify.notified().await;
                continue;
            }
            let has_unseen = match rx.has_changed() {
                Ok(v) => v,
                Err(_) => return None,
            };
            if !has_unseen && rx.changed().await.is_err() {
                return None;
            }
            if self.try_consume_credit() {
                let latest = rx.borrow_and_update().clone();
                if latest.is_empty() {
                    // Initial empty watch placeholder: restore credit and wait for a real frame
                    self.grant_credit();
                    continue;
                }
                return Some(latest);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn credit_gate_drops_intermediate_frames_when_ui_stalled() {
        let gate = FrameCreditGate::new(true);
        let (tx, mut rx) = watch::channel(Vec::new());

        tx.send(vec![1]).unwrap();
        let f1 = gate.wait_for_frame(&mut rx).await.unwrap();
        assert_eq!(f1, vec![1]);
        assert!(!gate.has_credit());

        tx.send(vec![2]).unwrap();
        tx.send(vec![3]).unwrap();

        assert!(!gate.try_consume_credit());

        gate.grant_credit();
        let f3 = gate.wait_for_frame(&mut rx).await.unwrap();
        assert_eq!(f3, vec![3]);
    }
}
