import React, { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { useSse } from "../contexts/SseContext";

interface ChatComposerProps {
  isLoading: boolean;
  isOtherRunning?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  focusKey?: number;
}

interface SlashCommand {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help",        description: "Show help and available commands" },
  { name: "/clear",       description: "Clear conversation history" },
  { name: "/compact",     description: "Compact conversation with optional instructions" },
  { name: "/config",      description: "Open config panel" },
  { name: "/cost",        description: "Show token usage and cost" },
  { name: "/doctor",      description: "Check Claude Code installation health" },
  { name: "/init",        description: "Initialize project with CLAUDE.md" },
  { name: "/login",       description: "Switch Anthropic accounts" },
  { name: "/logout",      description: "Log out" },
  { name: "/memory",      description: "Edit memory files" },
  { name: "/mcp",         description: "Manage MCP servers" },
  { name: "/model",       description: "Set or switch model" },
  { name: "/pr_comments", description: "Get PR comments" },
  { name: "/review",      description: "Request code review" },
  { name: "/status",      description: "Show account / model status" },
  { name: "/terminal",    description: "Run shell command" },
  { name: "/vim",         description: "Enter vim mode" },
];

export default function ChatComposer({ isLoading, isOtherRunning, onSend, onStop, focusKey }: ChatComposerProps) {
  const { uploadAction, csrfToken, uploadDir } = useSse();

  const [input, setInput] = useState("");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Focus the composer on mount and whenever focusKey changes (e.g. "New Chat" clicked)
  useEffect(() => {
    textareaRef.current?.focus();
  }, [focusKey]);

  // Refocus when the loading state clears (streaming finished) so the user can keep typing
  useEffect(() => {
    if (!isLoading) {
      textareaRef.current?.focus();
    }
  }, [isLoading]);

  const busy = isLoading || uploading;
  const blocked = busy || (isOtherRunning ?? false);

  const filteredCommands = input.startsWith("/")
    ? SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(input.split(" ")[0].toLowerCase()))
    : [];

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setPendingFiles((prev) => [...prev, ...files]);
    e.target.value = "";
  }, []);

  const removeFile = useCallback((idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && pendingFiles.length === 0) return;
    if (blocked || uploading) return;

    let finalText = text;

    if (pendingFiles.length > 0 && uploadAction) {
      setUploading(true);
      const uploadedPaths: string[] = [];
      for (const file of pendingFiles) {
        const formData = new FormData();
        formData.append("path", uploadDir.replace(/\/$/, "") + "/" + file.name.replace(/[/\\]/g, "_"));
        formData.append("file", file);
        try {
          const res = await fetch(uploadAction, { method: "POST", headers: { "x-csrf-token": csrfToken }, body: formData });
          if (res.ok) uploadedPaths.push(uploadDir.replace(/\/$/, "") + "/" + file.name.replace(/[/\\]/g, "_"));
        } catch (err) { console.error("File upload failed", err); }
      }
      setUploading(false);
      if (uploadedPaths.length > 0) {
        const note = uploadedPaths.map((p) => `Uploaded file: ${p}`).join("\n");
        finalText = finalText ? `${finalText}\n\n${note}` : note;
      }
      setPendingFiles([]);
    }

    if (!finalText) return;

    setInput("");
    setSlashMenuOpen(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    textareaRef.current?.focus();
    onSend(finalText);
  }, [input, blocked, uploading, pendingFiles, uploadAction, csrfToken, uploadDir, onSend]);

  const selectCommand = useCallback((cmd: SlashCommand) => {
    setInput(cmd.name + " ");
    setSlashMenuOpen(false);
    setSlashMenuIndex(0);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashMenuOpen && filteredCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashMenuIndex((i) => (i + 1) % filteredCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectCommand(filteredCommands[slashMenuIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [slashMenuOpen, filteredCommands, slashMenuIndex, selectCommand, handleSend],
  );

  const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    target.style.height = "auto";
    target.style.height = Math.min(target.scrollHeight, 260) + "px";
    const value = target.value;
    setInput(value);
    setSlashMenuIndex(0);
    setSlashMenuOpen(value.startsWith("/") && !value.includes(" "));
  }, []);

  const menuVisible = slashMenuOpen && filteredCommands.length > 0;

  return (
    <div className="flex-shrink-0 border-t border-border bg-card/60 px-3 pb-3 pt-2">
      <div className="mx-auto max-w-3xl">
        <div className="relative">

          {/* Slash command menu */}
          {menuVisible && (
            <div className="absolute bottom-full left-0 right-0 mb-1.5 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.name}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); selectCommand(cmd); }}
                  className={`flex w-full items-baseline gap-3 px-3 py-2 text-left ${
                    i === slashMenuIndex ? "bg-accent" : "hover:bg-accent/60"
                  }`}
                >
                  <span className="font-mono text-xs font-medium text-foreground">{cmd.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{cmd.description}</span>
                </button>
              ))}
            </div>
          )}

          {/* Pending file chips */}
          {pendingFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pendingFiles.map((file, i) => (
                <span
                  key={file.name + '-' + i}
                  className="flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-foreground"
                >
                  <Paperclip className="h-2.5 w-2.5 text-muted-foreground" />
                  <span className="max-w-[160px] truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="ml-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Input row */}
          <div className="flex items-end gap-2 rounded-2xl border border-border bg-background px-3 py-2 shadow-sm focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/20">

            {/* File upload button */}
            <button
              type="button"
              title="Attach file"
              onClick={() => fileInputRef.current?.click()}
              disabled={blocked}
              className="mb-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />

            <textarea
              ref={textareaRef}
              value={input}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Message Claude…"
              disabled={blocked}
              rows={1}
              className="max-h-[260px] min-h-[36px] flex-1 resize-none bg-transparent py-1 text-sm text-foreground placeholder-muted-foreground/50 focus:outline-none disabled:opacity-60"
              style={{ height: "36px" }}
            />

            {uploading ? (
              <div className="mb-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
              </div>
            ) : busy ? (
              <button
                type="button"
                onClick={onStop}
                title="Stop (Esc)"
                className="mb-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-destructive text-destructive-foreground hover:opacity-90"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={blocked || (!input.trim() && pendingFiles.length === 0)}
                title="Send"
                className="mb-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:opacity-90 disabled:bg-muted disabled:text-muted-foreground"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/40">
          Enter to send · Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}
