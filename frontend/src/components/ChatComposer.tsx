import React, { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { useSse } from "../contexts/SseContext";
import CommandPalette from "./CommandPalette";
import ModelChip from "./ModelChip";

interface ChatComposerProps {
  isLoading: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  focusKey?: number;
  droppedFiles?: File[];
}

export default function ChatComposer({
  isLoading,
  onSend,
  onStop,
  focusKey,
  droppedFiles,
}: ChatComposerProps) {
  const { uploadAction, csrfFetch } = useSse();

  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map());
  const [stashedDraft, setStashedDraft] = useState<string | null>(null);

  // Stash draft when streaming starts, restore when it ends
  const prevLoading = useRef(isLoading);
  useEffect(() => {
    if (isLoading && !prevLoading.current) {
      // Streaming just started — save current input if non-empty
      if (input.trim()) {
        setStashedDraft(input);
        setInput("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      }
    } else if (!isLoading && prevLoading.current && stashedDraft) {
      // Streaming just ended — restore draft
      setInput(stashedDraft);
      setStashedDraft(null);
    }
    prevLoading.current = isLoading;
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      imageUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

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

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setPendingFiles((prev) => [...prev, ...files]);
    setImageUrls((prev) => {
      const next = new Map(prev);
      files.forEach((f) => {
        if (f.type.startsWith("image/")) {
          next.set(f.name + "-" + f.size, URL.createObjectURL(f));
        }
      });
      return next;
    });
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(e.target.files ?? []));
      e.target.value = "";
    },
    [addFiles],
  );

  // Consume files dropped onto the parent drag zone
  useEffect(() => {
    if (droppedFiles && droppedFiles.length > 0) {
      addFiles(droppedFiles);
    }
  }, [droppedFiles, addFiles]);

  const removeFile = useCallback((idx: number) => {
    setPendingFiles((prev) => {
      const file = prev[idx];
      if (file && file.type.startsWith("image/")) {
        const key = file.name + "-" + file.size;
        setImageUrls((urls) => {
          const next = new Map(urls);
          const url = next.get(key);
          if (url) URL.revokeObjectURL(url);
          next.delete(key);
          return next;
        });
      }
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && pendingFiles.length === 0) return;
    if (uploading) return;

    let finalText = text;

    if (pendingFiles.length > 0 && uploadAction) {
      setUploading(true);
      const uploadedPaths: string[] = [];
      for (const file of pendingFiles) {
        const formData = new FormData();
        formData.append("file", file);
        try {
          const res = await csrfFetch(uploadAction, {
            method: "POST",
            body: formData,
          });
          if (res.ok) {
            const data = await res.json();
            if (data.path) uploadedPaths.push(data.path);
          }
        } catch (err) {
          console.error("File upload failed", err);
        }
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
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    textareaRef.current?.focus();
    onSend(finalText);
  }, [input, uploading, pendingFiles, uploadAction, csrfFetch, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape" && isLoading) {
        e.preventDefault();
        onStop();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, isLoading, onStop],
  );

  const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    target.style.height = "auto";
    target.style.height = Math.min(target.scrollHeight, 260) + "px";
    const val = target.value;
    setInput(val);
    if (val.startsWith("/") && !val.includes(" ") && !val.includes("\n")) {
      setShowCommands(true);
      setCommandFilter(val.slice(1));
    } else {
      setShowCommands(false);
    }
  }, []);

  const handleCommandSelect = useCallback(
    (command: string) => {
      setShowCommands(false);
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      textareaRef.current?.focus();
      onSend(command);
    },
    [onSend],
  );

  const handleCommandClose = useCallback(() => {
    setShowCommands(false);
  }, []);

  return (
    <div className="flex-shrink-0 border-t border-border bg-card/70 px-3 pb-3 pt-2">
      <div className="mx-auto max-w-3xl">
        <div className="relative">
          {/* Pending file chips */}
          {pendingFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pendingFiles.map((file, i) => {
                const imgKey = file.name + "-" + file.size;
                const thumbUrl = file.type.startsWith("image/")
                  ? imageUrls.get(imgKey)
                  : undefined;
                return (
                  <span
                    key={file.name + "-" + i}
                    className="flex items-center gap-1 rounded-full border border-border/60 bg-card px-2.5 py-1 text-sm text-foreground shadow-sm"
                  >
                    {thumbUrl ? (
                      <img
                        src={thumbUrl}
                        alt=""
                        className="h-5 w-5 rounded object-cover"
                      />
                    ) : (
                      <Paperclip className="h-2.5 w-2.5 text-muted-foreground" />
                    )}
                    <span className="max-w-[160px] truncate">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="ml-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* Command palette */}
          {showCommands && (
            <CommandPalette
              filter={commandFilter}
              onSelect={handleCommandSelect}
              onClose={handleCommandClose}
            />
          )}

          {/* Input row */}
          <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-lg shadow-black/8 transition-shadow duration-250 focus-within:border-primary/25 focus-within:shadow-xl focus-within:shadow-primary/8 focus-within:ring-2 focus-within:ring-primary/10">
            {/* File upload button */}
            <button
              type="button"
              title="Attach file"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
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
              rows={1}
              className="max-h-[260px] min-h-[32px] flex-1 resize-none bg-transparent py-[5px] text-base leading-snug text-foreground placeholder-muted-foreground/40 focus:outline-none"
              style={{ height: "32px" }}
            />

            <ModelChip />

            {uploading ? (
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                {busy && (
                  <button
                    type="button"
                    onClick={onStop}
                    title="Stop (Esc)"
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-destructive text-destructive-foreground shadow-sm hover:opacity-90"
                  >
                    <Square className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!input.trim() && pendingFiles.length === 0}
                  title={busy ? "Queue message" : "Send"}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/35 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-50 disabled:shadow-none"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          {stashedDraft && (
            <div className="mt-1.5 px-1">
              <span className="text-xs text-primary/70">
                Draft saved — will restore when done
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
