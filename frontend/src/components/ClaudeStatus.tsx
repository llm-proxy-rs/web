import React, { useEffect, useState } from "react";

const ACTION_WORDS = ["Thinking", "Processing", "Analyzing", "Working", "Computing", "Reasoning"];
const ANIMATION_STEPS = 40;

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

export default function ClaudeStatus({ isLoading, onAbort }: ClaudeStatusProps) {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [animationPhase, setAnimationPhase] = useState(0);

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

  useEffect(() => {
    if (!isLoading) return;
    const timer = window.setInterval(() => {
      setAnimationPhase((prev) => (prev + 1) % ANIMATION_STEPS);
    }, 500);
    return () => window.clearInterval(timer);
  }, [isLoading]);

  if (!isLoading) return null;

  const actionIndex = Math.floor(elapsedTime / 3) % ACTION_WORDS.length;
  const statusText = ACTION_WORDS[actionIndex];
  const animatedDots = ".".repeat((animationPhase % 3) + 1);
  const elapsedLabel = elapsedTime > 0 ? `${formatElapsedTime(elapsedTime)} elapsed` : "Starting now";

  return (
    <div className="px-3 pb-2">
      <div className="mx-auto max-w-3xl">
        <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card/90 shadow-md backdrop-blur-md">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-primary/10 via-transparent to-sky-500/10" />
          <div className="relative flex items-center justify-between px-3 py-2.5">
            <div className="flex items-center gap-3" role="status" aria-live="polite">
              <div className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10">
                <div className="text-[10px] font-bold text-primary">C</div>
                <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                </span>
              </div>
              <div>
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  <span>Claude</span>
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] tracking-wide text-emerald-500">
                    Live
                  </span>
                </div>
                <p className="text-sm font-semibold text-foreground">
                  {statusText}
                  <span aria-hidden="true" className="text-primary">{animatedDots}</span>
                </p>
                <div className="mt-0.5 flex items-center text-[11px] text-muted-foreground">
                  <span className="rounded-full border border-border/70 bg-background/60 px-2 py-0.5">
                    {elapsedLabel}
                  </span>
                </div>
              </div>
            </div>
            {onAbort && (
              <button
                type="button"
                onClick={onAbort}
                className="inline-flex items-center gap-1.5 rounded-xl bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground shadow-sm ring-1 ring-destructive/40 transition-opacity hover:opacity-95 focus-visible:outline-none"
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Stop
                <span className="rounded-md bg-black/20 px-1 py-0.5 text-[9px] uppercase tracking-wide text-destructive-foreground/95">
                  Esc
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
