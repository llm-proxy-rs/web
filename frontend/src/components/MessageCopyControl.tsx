import React, { useEffect, useRef, useState } from "react";

const COPY_SUCCESS_TIMEOUT_MS = 2000;

interface MessageCopyControlProps {
  content: string;
  messageType: "user" | "assistant";
}

export default function MessageCopyControl({
  content,
  messageType,
}: MessageCopyControlProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (!content.trim()) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setCopyFailed(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => setCopied(false),
        COPY_SUCCESS_TIMEOUT_MS,
      );
    } catch {
      setCopyFailed(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => setCopyFailed(false),
        COPY_SUCCESS_TIMEOUT_MS,
      );
    }
  };

  const toneClass =
    messageType === "user"
      ? "text-blue-100 hover:text-white"
      : "text-muted-foreground hover:text-foreground";

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied!" : copyFailed ? "Copy failed" : "Copy"}
      aria-label={copied ? "Copied!" : copyFailed ? "Copy failed" : "Copy"}
      className={`inline-flex items-center rounded p-0.5 transition-colors ${toneClass}`}
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
    </button>
  );
}
