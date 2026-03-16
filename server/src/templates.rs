use std::path::Path;

use html_escape::encode_double_quoted_attribute;

pub(crate) fn render_login_page() -> String {
    r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Web</title>
</head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f0f0f;color:#fff;font-family:sans-serif">
<div style="text-align:center">
<h1 style="margin-bottom:1.5rem;font-size:1rem;font-weight:bold">Web</h1>
<a href="/login/cognito" style="display:inline-block;padding:0.5rem 1.5rem;background:#3b82f6;color:#fff;border-radius:0.5rem;text-decoration:none">Sign in</a>
</div>
</body>
</html>"#.to_owned()
}

pub(crate) fn render_terminal_page(
    vm_id: &str,
    csrf_token: &str,
    upload_dir: &Path,
    has_user_rootfs: bool,
) -> String {
    let upload_action = "/chat-upload".to_owned();
    let app_js_src = format!("/static/app.js?v={}", env!("APP_JS_VERSION"));
    let styles_css_href = format!("/static/styles.css?v={}", env!("STYLES_CSS_VERSION"));
    let has_user_rootfs_str = has_user_rootfs.to_string();
    let vm_id = encode_double_quoted_attribute(vm_id);
    let csrf_token = encode_double_quoted_attribute(csrf_token);
    let upload_dir_lossy = upload_dir.to_string_lossy();
    let upload_dir = encode_double_quoted_attribute(&upload_dir_lossy);
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Web</title>
<link rel="stylesheet" href="{styles_css_href}"/>
</head>
<body class="flex h-screen overflow-hidden bg-background text-foreground">
<div id="app-config" hidden
  data-vm-id="{vm_id}"
  data-csrf-token="{csrf_token}"
  data-upload-dir="{upload_dir}"
  data-upload-action="{upload_action}"
  data-has-user-rootfs="{has_user_rootfs_str}"
></div>
<div id="app" class="flex h-screen w-screen overflow-hidden"></div>
<script src="{app_js_src}" defer></script>
</body>
</html>"#
    )
}
