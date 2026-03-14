use russh_sftp::client::{SftpSession, fs::DirEntry};
use std::path::{Path, PathBuf};

// Returns all project directories under ~/.claude/projects on the remote VM.
// Each subdirectory there corresponds to one Claude Code project (named by
// its encoded working directory path) and contains the session JSONL files.
pub(crate) async fn find_all_project_dirs(
    sftp: &SftpSession,
    ssh_user_home: &Path,
) -> Vec<PathBuf> {
    let projects_base = build_projects_base_path(ssh_user_home);
    // Directory may not exist yet on a fresh VM; treat as empty rather than an error
    let top_entries: Vec<DirEntry> = sftp
        .read_dir(projects_base.to_str().expect("path is valid UTF-8"))
        .await
        .map(|entries| entries.collect())
        .unwrap_or_default();
    let mut project_dirs = Vec::new();
    for entry in top_entries {
        let name = entry.file_name();
        if name.starts_with('.') {
            continue;
        }
        let path = projects_base.join(&name);
        if entry.file_type().is_dir() {
            project_dirs.push(path);
        }
    }
    project_dirs
}

fn build_projects_base_path(ssh_user_home: &Path) -> PathBuf {
    ssh_user_home.join(".claude/projects")
}
