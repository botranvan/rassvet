// The UI is embedded from ui/dist. Make sure the folder exists so `cargo build`
// works before the frontend has been built (the server then shows a hint page).
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist");
    if !dist.exists() {
        let _ = std::fs::create_dir_all(&dist);
    }
    println!("cargo:rerun-if-changed=../../ui/dist");
}
