use anyhow::{Result, bail};
use std::path::Path;
use tokio::process::Command;

pub async fn copy_sparse(src: &Path, dst: &Path) -> Result<()> {
    let status = Command::new("cp")
        .args([
            "--sparse=always",
            &src.to_string_lossy(),
            &dst.to_string_lossy(),
        ])
        .status()
        .await?;
    if !status.success() {
        bail!(
            "failed to sparse copy from {} to {}",
            src.display(),
            dst.display()
        );
    }
    Ok(())
}

pub fn validate_within_dir(real_path: &Path, allowed_dir: &Path) -> Result<()> {
    if !real_path.starts_with(allowed_dir) {
        bail!("path is outside the allowed directory");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_within_dir_passes() {
        assert!(
            validate_within_dir(Path::new("/uploads/user/file.txt"), Path::new("/uploads")).is_ok()
        );
    }

    #[test]
    fn test_path_in_nested_subdir_passes() {
        assert!(
            validate_within_dir(Path::new("/uploads/a/b/c/d.txt"), Path::new("/uploads")).is_ok()
        );
    }

    #[test]
    fn test_path_equal_to_dir_passes() {
        assert!(validate_within_dir(Path::new("/uploads"), Path::new("/uploads")).is_ok());
    }

    #[test]
    fn test_path_outside_dir_fails() {
        assert!(validate_within_dir(Path::new("/etc/passwd"), Path::new("/uploads")).is_err());
    }

    #[test]
    fn test_path_with_shared_string_prefix_but_different_component_fails() {
        // "/uploads-evil" shares the string prefix "/uploads" but is a different
        // directory component — starts_with is component-based, not string-based.
        assert!(
            validate_within_dir(Path::new("/uploads-evil/file.txt"), Path::new("/uploads"))
                .is_err()
        );
    }

    #[test]
    fn test_parent_dir_fails() {
        assert!(validate_within_dir(Path::new("/"), Path::new("/uploads")).is_err());
    }

    #[test]
    fn test_traversal_without_canonicalization_bypasses_check() {
        // Path::starts_with does not resolve "..": the components of
        // "/uploads/../etc/passwd" start with [/, uploads] so the check passes.
        // This documents why callers must canonicalize paths before calling this function.
        assert!(
            validate_within_dir(Path::new("/uploads/../etc/passwd"), Path::new("/uploads")).is_ok()
        );
    }
}
