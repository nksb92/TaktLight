pub mod engine;
pub mod frame;
pub mod ofl;
pub mod protocol;
pub mod state;
pub mod telemetry;

#[cfg(test)]
mod tests {
    #[test]
    fn workspace_compiles() {
        assert_eq!(2 + 2, 4);
    }
}
