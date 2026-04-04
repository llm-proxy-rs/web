import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import type { StreamPhaseInfo } from "../types";

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function phaseLabel(info: StreamPhaseInfo): string {
  switch (info.phase) {
    case "processing":
      return "Processing";
    case "thinking":
      return "Thinking";
    case "responding":
      return "Responding";
    case "tool_use":
      return info.toolName ? `Using ${info.toolName}` : "Using tool";
    default:
      return "Processing";
  }
}

const DONE_DISPLAY_MS = 4000;

interface ClaudeStatusProps {
  isLoading: boolean;
  streamPhase: StreamPhaseInfo;
  startTime?: number;
}

export default function ClaudeStatus({
  isLoading,
  streamPhase,
  startTime,
}: ClaudeStatusProps) {
  const [, setTick] = useState(0);
  const [doneInfo, setDoneInfo] = useState<{ elapsed: number } | null>(null);
  const prevLoading = useRef(isLoading);

  // Tick every second while loading
  useEffect(() => {
    if (!isLoading) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isLoading]);

  // Show "Done" state when loading transitions to false
  useEffect(() => {
    if (prevLoading.current && !isLoading && startTime) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed >= 1) {
        setDoneInfo({ elapsed });
        const timer = setTimeout(() => setDoneInfo(null), DONE_DISPLAY_MS);
        return () => clearTimeout(timer);
      }
    }
    prevLoading.current = isLoading;
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show "Done · Xs" briefly after completion
  if (!isLoading && doneInfo) {
    return (
      <div className="px-4 py-2">
        <div className="flex items-center gap-2.5">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          <span className="text-sm font-medium text-emerald-500/70">
            Done
            <span className="ml-1.5 tabular-nums font-normal text-muted-foreground/35">
              · {formatElapsedTime(doneInfo.elapsed)}
            </span>
          </span>
        </div>
      </div>
    );
  }

  if (!isLoading) return null;

  const elapsedTime = startTime
    ? Math.floor((Date.now() - startTime) / 1000)
    : 0;
  const statusText = phaseLabel(streamPhase);
  const elapsedLabel = formatElapsedTime(elapsedTime);

  return (
    <div className="px-4 py-2">
      <div
        className="flex items-center gap-2.5"
        role="status"
        aria-live="polite"
      >
        <span className="flex items-center gap-[3px]" aria-hidden="true">
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary/70" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary/70" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary/70" />
        </span>
        <span className="text-sm font-medium text-muted-foreground">
          {statusText}
          <span className="ml-1.5 tabular-nums font-normal text-muted-foreground/35">
            · {elapsedLabel}
          </span>
        </span>
      </div>
    </div>
  );
}
