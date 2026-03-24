use html_escape::encode_double_quoted_attribute;
use std::path::Path;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn login_page_contains_sign_in_link() {
        let html = render_login_page();
        assert!(html.contains("/login/cognito"));
        assert!(html.contains("Sign in"));
        assert!(html.contains("<!DOCTYPE html>"));
    }

    #[test]
    fn terminal_page_embeds_vm_id() {
        let html = render_terminal_page("vm-123", "csrf-tok", Path::new("/tmp"), false);
        assert!(html.contains(r#"data-vm-id="vm-123""#));
        assert!(html.contains(r#"data-csrf-token="csrf-tok""#));
        assert!(html.contains(r#"data-upload-dir="/tmp""#));
        assert!(html.contains(r#"data-has-user-rootfs="false""#));
    }

    #[test]
    fn terminal_page_has_user_rootfs_true() {
        let html = render_terminal_page("vm-1", "tok", Path::new("/uploads"), true);
        assert!(html.contains(r#"data-has-user-rootfs="true""#));
    }

    #[test]
    fn terminal_page_escapes_html_in_vm_id() {
        let html = render_terminal_page(r#"vm"<script>"#, "tok", Path::new("/tmp"), false);
        // The attribute value should be HTML-escaped
        assert!(!html.contains(r#"data-vm-id="vm"<script>""#));
        assert!(html.contains("&quot;"));
    }

    #[test]
    fn terminal_page_includes_versioned_assets() {
        let html = render_terminal_page("vm", "tok", Path::new("/tmp"), false);
        assert!(html.contains("/static/app.js?v="));
        assert!(html.contains("/static/styles.css?v="));
    }

    #[test]
    fn terminal_page_empty_vm_id() {
        let html = render_terminal_page("", "tok", Path::new("/tmp"), false);
        assert!(html.contains(r#"data-vm-id="""#));
    }
}
