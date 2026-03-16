import React, { useEffect, useMemo, useRef, useState } from "react";

const COPY_SUCCESS_TIMEOUT_MS = 2000;

type CopyFormat = "text" | "markdown";

function convertMarkdownToPlainText(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n");
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w-]*\n([\s\S]*?)```/g, (_match, code: string) => {
    const placeholder = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push(code.replace(/\n$/, ""));
    return placeholder;
  });
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^[-*+]\s+/gm, "");
  text = text.replace(/^\d+\.\s+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/<\/?[^>]+(>|$)/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/@@CODEBLOCK(\d+)@@/g, (_match, index: string) => codeBlocks[Number(index)] ?? "");
  return text.trim();
}

interface MessageCopyControlProps {
  content: string;
  messageType: "user" | "assistant";
}

export default function MessageCopyControl({ content, messageType }: MessageCopyControlProps) {
  const canSelectFormat = messageType === "assistant";
  const [selectedFormat, setSelectedFormat] = useState<CopyFormat>(canSelectFormat ? "markdown" : "text");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!isDropdownOpen) return;
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => window.removeEventListener("mousedown", closeOnOutsideClick);
  }, [isDropdownOpen]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copyPayload = useMemo(() => {
    if (selectedFormat === "markdown") return content;
    return convertMarkdownToPlainText(content);
  }, [content, selectedFormat]);

  const handleCopy = async () => {
    if (!copyPayload.trim()) return;
    try {
      await navigator.clipboard.writeText(copyPayload);
      setCopied(true);
      setCopyFailed(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPY_SUCCESS_TIMEOUT_MS);
    } catch {
      setCopyFailed(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyFailed(false), COPY_SUCCESS_TIMEOUT_MS);
    }
  };

  const toneClass =
    messageType === "user"
      ? "text-blue-100 hover:text-white"
      : "text-muted-foreground hover:text-foreground";

  const formatTag = selectedFormat === "markdown" ? "MD" : "TXT";

  return (
    <div ref={dropdownRef} className="relative flex items-center gap-0.5">
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? "Copied!" : copyFailed ? "Copy failed" : "Copy"}
        aria-label={copied ? "Copied!" : copyFailed ? "Copy failed" : "Copy"}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors ${toneClass}`}
      >
        {copied ? (
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        ) : (
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
        <span className="text-[10px] font-semibold uppercase tracking-wide">{formatTag}</span>
      </button>

      {canSelectFormat && (
        <>
          <button
            type="button"
            onClick={() => setIsDropdownOpen((prev) => !prev)}
            className={`rounded px-1 py-0.5 transition-colors ${toneClass}`}
            aria-label="Select copy format"
            title="Select copy format"
          >
            <svg
              className={`h-3 w-3 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {isDropdownOpen && (
            <div className="absolute left-auto top-full z-30 mt-1 min-w-36 rounded-md border border-border bg-card p-1 shadow-lg">
              {(["markdown", "text"] as CopyFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => {
                    setSelectedFormat(fmt);
                    setIsDropdownOpen(false);
                  }}
                  className={`block w-full rounded px-2 py-1.5 text-left text-xs font-medium transition-colors ${
                    selectedFormat === fmt
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                >
                  {fmt === "markdown" ? "Copy as markdown" : "Copy as text"}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
