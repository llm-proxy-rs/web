import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useSse } from "../contexts/SseContext";

const MODEL_OPTIONS = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "sonnet[1m]", label: "Sonnet [1m]" },
  { value: "opus[1m]", label: "Opus [1m]" },
];

function displayLabel(model: string): string {
  const opt = MODEL_OPTIONS.find((o) => o.value === model);
  return opt ? opt.label : model;
}

export default function ModelChip() {
  const { csrfFetch } = useSse();
  const [model, setModel] = useState("sonnet");
  const [open, setOpen] = useState(false);
  const [saveResult, setSaveResult] = useState<"success" | "error" | null>(
    null,
  );
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setModel(data.model ?? "sonnet");
      })
      .catch((e) => {
        console.error("Failed to load settings", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Clean up close timer on unmount
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const handleChange = useCallback(
    async (value: string) => {
      setModel(value);
      setSaveResult(null);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      try {
        const res = await csrfFetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: value }),
        });
        const result = res.ok ? "success" : "error";
        setSaveResult(result);
        // Auto-close after brief feedback
        closeTimerRef.current = setTimeout(() => {
          setOpen(false);
          setSaveResult(null);
        }, 600);
      } catch (e) {
        console.error("Failed to update model", e);
        setSaveResult("error");
      }
    },
    [csrfFetch],
  );

  return (
    <div className="relative" ref={popoverRef}>
      <button
        title="Change model"
        onClick={() => {
          setOpen((v) => !v);
          setSaveResult(null);
        }}
        className="flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {displayLabel(model)}
        <ChevronDown className="h-3 w-3 opacity-50" />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-1 rounded-xl border border-border bg-card p-1.5 shadow-xl">
          <div className="flex flex-col gap-0.5" style={{ minWidth: "130px" }}>
            {MODEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleChange(opt.value)}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-xs font-medium transition-colors ${
                  model === opt.value
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-accent"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {/* Fixed-height status area to prevent layout shift */}
          <div className="h-4 flex items-center justify-center">
            {saveResult === "success" && (
              <p className="fade-in text-center text-[10px] text-emerald-500">
                Updated
              </p>
            )}
            {saveResult === "error" && (
              <p className="fade-in text-center text-[10px] text-red-400">
                Failed
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
