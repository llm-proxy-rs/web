import React, { useEffect, useState } from "react";

const ACTION_WORDS = [
  "Thinking",
  "Processing",
  "Analyzing",
  "Working",
  "Computing",
  "Reasoning",
];

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

interface ClaudeStatusProps {
  isLoading: boolean;
  onAbort?: () => void;
}

export default function ClaudeStatus({
  isLoading,
  onAbort,
}: ClaudeStatusProps) {
  const [elapsedTime, setElapsedTime] = useState(0);

  useEffect(() => {
    if (!isLoading) {
      setElapsedTime(0);
      return;
    }
    const startTime = Date.now();
    const timer = window.setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isLoading]);

  if (!isLoading) return null;

  const actionIndex = Math.floor(elapsedTime / 3) % ACTION_WORDS.length;
  const statusText = ACTION_WORDS[actionIndex];
  const elapsedLabel =
    elapsedTime > 0 ? formatElapsedTime(elapsedTime) : "";

  return (
    <div className="px-4 py-1.5">
      <div
        className="flex items-center gap-2"
        role="status"
        aria-live="polite"
      >
        <span className="flex items-center gap-[3px]" aria-hidden="true">
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary/70" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary/70" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary/70" />
        </span>
        <span className="text-xs text-muted-foreground">
          Claude is {statusText.toLowerCase()}
          {elapsedLabel && (
            <span className="ml-1.5 text-muted-foreground/50">
              · {elapsedLabel}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
