use anyhow::{Context, Result};
use russh_sftp::client::{SftpSession, fs::DirEntry};
use std::path::{Path, PathBuf};

// Returns all project directories under ~/.claude/projects on the remote VM.
// Each subdirectory there corresponds to one Claude Code project (named by
// its encoded working directory path) and contains the session JSONL files.
pub(crate) async fn find_all_project_dirs(
    sftp: &SftpSession,
    ssh_user_home: &Path,
) -> Result<Vec<PathBuf>> {
    let projects_base = build_projects_base_path(ssh_user_home);
    let top_entries: Vec<DirEntry> = match sftp
        .read_dir(projects_base.to_str().context("path is not valid UTF-8")?)
        .await
    {
        Ok(entries) => entries.collect(),
        Err(e)
            if e.to_string().to_lowercase().contains("not found")
                || e.to_string().to_lowercase().contains("no such file") =>
        {
            // projects dir may not exist yet if Claude Code has never been run
            return Ok(Vec::new());
        }
        Err(e) => {
            return Err(e).context("failed to read projects directory");
        }
    };
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
    Ok(project_dirs)
}

fn build_projects_base_path(ssh_user_home: &Path) -> PathBuf {
    ssh_user_home.join(".claude/projects")
}
