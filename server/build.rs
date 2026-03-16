use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=../frontend/dist/app.js");
    println!("cargo:rerun-if-changed=../frontend/dist/styles.css");

    let app_js_version = hash_file(Path::new("../frontend/dist/app.js"));
    let styles_css_version = hash_file(Path::new("../frontend/dist/styles.css"));

    println!("cargo:rustc-env=APP_JS_VERSION={app_js_version}");
    println!("cargo:rustc-env=STYLES_CSS_VERSION={styles_css_version}");
}

fn hash_file(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(data) => format!("{:x}", fnv1a(&data)),
        Err(_) => "dev".to_string(),
    }
}

fn fnv1a(data: &[u8]) -> u64 {
    let mut hash: u64 = 14695981039346656037;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    hash
}
