#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running TaktLight application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn tauri_shell_compiles() {
        assert_eq!(1, 1);
    }
}
