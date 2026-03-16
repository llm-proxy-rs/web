import React, { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronRight, Download, Folder, File, Upload } from "lucide-react";
import { useSse } from "../contexts/SseContext";
import type { FileEntry } from "../types";

function formatSize(n: number): string {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function parentPath(path: string, rootPath: string): string {
  const stripped = path.replace(/\/$/, "");
  const idx = stripped.lastIndexOf("/");
  const parent = idx <= 0 ? "/" : stripped.substring(0, idx);
  return parent.length < rootPath.length ? rootPath : parent;
}

export default function FileManager() {
  const { vmId, uploadDir, uploadAction, csrfToken } = useSse();
  const [currentPath, setCurrentPath] = useState(uploadDir);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const uploadTimeoutRef = useRef<number | null>(null);

  const loadDir = useCallback(async (path: string, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/sessions/${vmId}/ls?path=${encodeURIComponent(path)}`, { signal });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setCurrentPath(path);
      setEntries(data.entries as FileEntry[]);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [vmId]);

  useEffect(() => {
    const abortController = new AbortController();
    loadDir(uploadDir, abortController.signal);
    return () => abortController.abort();
  }, [uploadDir, loadDir]);

  const handleUpload = useCallback(async (file: File) => {
    flushSync(() => setUploadStatus("Uploading…"));
    const formData = new FormData();
    formData.append("path", currentPath.replace(/\/$/, "") + "/" + file.name.replace(/[/\\]/g, "_"));
    formData.append("file", file);
    try {
      const res = await fetch(uploadAction, { method: "POST", headers: { "x-csrf-token": csrfToken }, body: formData });
      if (res.ok) {
        setUploadStatus("Uploaded.");
        loadDir(currentPath);
      } else {
        setUploadStatus("Upload failed.");
      }
    } catch {
      setUploadStatus("Network error.");
    }
    uploadTimeoutRef.current = window.setTimeout(() => setUploadStatus(null), 3000);
  }, [csrfToken, currentPath, uploadAction, loadDir]);

  useEffect(() => {
    return () => {
      if (uploadTimeoutRef.current !== null) {
        clearTimeout(uploadTimeoutRef.current);
      }
    };
  }, []);

  const breadcrumbParts = buildBreadcrumb(currentPath, uploadDir);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold text-foreground">Files</span>
        <label
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Upload file"
        >
          <Upload className="h-3.5 w-3.5" />
          Upload
          <input
            type="file"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleUpload(f); e.target.value = ""; } }}
          />
        </label>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        {breadcrumbParts.map((part, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight className="h-3 w-3 flex-shrink-0 opacity-40" />}
            {part.path ? (
              <button
                onClick={() => loadDir(part.path!)}
                className="truncate hover:text-foreground hover:underline"
              >
                {part.label}
              </button>
            ) : (
              <span className="truncate text-foreground">{part.label}</span>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Upload status */}
      {uploadStatus && (
        <div className="border-b border-border bg-accent/20 px-3 py-1 text-xs text-muted-foreground">
          {uploadStatus}
        </div>
      )}

      {/* File list */}
      <div
        className="flex-1 overflow-y-auto"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleUpload(f); }}
      >
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
            Loading…
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-xs text-destructive">{error}</div>
        ) : (
          <>
            {currentPath !== uploadDir && (
              <FileRow
                icon={<span className="text-muted-foreground opacity-60">‹</span>}
                name=".."
                nameClass="text-muted-foreground"
                onClick={() => loadDir(parentPath(currentPath, uploadDir))}
              />
            )}
            {entries.map((entry) => {
              const entryPath = currentPath.replace(/\/$/, "") + "/" + entry.name;
              return entry.is_dir ? (
                <FileRow
                  key={entry.name}
                  icon={<Folder className="h-3.5 w-3.5 text-blue-400" />}
                  name={entry.name}
                  nameClass="text-blue-400"
                  onClick={() => loadDir(entryPath)}
                  action={
                    <a
                      href={`/sessions/${vmId}/download?path=${encodeURIComponent(entryPath)}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Download as zip"
                      onClick={(e) => e.stopPropagation()}
                      className="ml-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  }
                />
              ) : (
                <FileRow
                  key={entry.name}
                  icon={<File className="h-3.5 w-3.5 text-muted-foreground" />}
                  name={entry.name}
                  nameClass="text-foreground"
                  onClick={() => window.open(`/sessions/${vmId}/download?path=${encodeURIComponent(entryPath)}`, "_blank")}
                  action={<span className="ml-1 text-[10px] text-muted-foreground opacity-50">{formatSize(entry.size)}</span>}
                />
              );
            })}
            {entries.length === 0 && (
              <div className="flex items-center justify-center py-8 text-xs text-muted-foreground opacity-60">
                Empty directory
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FileRow({
  icon,
  name,
  nameClass,
  onClick,
  action,
}: {
  icon: React.ReactNode;
  name: string;
  nameClass?: string;
  onClick?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      className="group flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs transition-colors hover:bg-accent/50"
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className={`flex-1 truncate ${nameClass ?? ""}`}>{name}</span>
      {action}
    </div>
  );
}

function buildBreadcrumb(
  path: string,
  rootPath: string,
): Array<{ label: string; path: string | null }> {
  const normalized = path.replace(/\/$/, "") || "/";
  const root = rootPath.replace(/\/$/, "") || "/";
  const parts: Array<{ label: string; path: string | null }> = [];

  const isAtRoot = normalized === root;
  parts.push({ label: "Home", path: isAtRoot ? null : root });

  if (!isAtRoot) {
    const suffix = normalized.slice(root.length);
    const subParts = suffix.split("/").filter(Boolean);
    subParts.forEach((part, i) => {
      const isCurrent = i === subParts.length - 1;
      const segPath = root + "/" + subParts.slice(0, i + 1).join("/");
      parts.push({ label: part, path: isCurrent ? null : segPath });
    });
  }

  return parts;
}
