import React, { useCallback, useEffect, useRef, useState } from "react";

interface SlashCommand {
  name: string;
  label: string;
  description: string;
}

const COMMANDS: SlashCommand[] = [
  { name: "commit", label: "/commit", description: "Create a git commit" },
  { name: "review", label: "/review", description: "Review code changes" },
  { name: "diff", label: "/diff", description: "Show git diff" },
  { name: "compact", label: "/compact", description: "Compress context" },
  { name: "memory", label: "/memory", description: "Manage persistent memory" },
  { name: "plan", label: "/plan", description: "Enter plan mode" },
];

interface CommandPaletteProps {
  filter: string;
  onSelect: (command: string) => void;
  onClose: () => void;
}

export default function CommandPalette({
  filter,
  onSelect,
  onClose,
}: CommandPaletteProps) {
  const filtered = COMMANDS.filter((c) =>
    c.name.startsWith(filter.toLowerCase()),
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex].label);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 z-50 mb-1 overflow-hidden rounded-xl border border-border bg-card shadow-xl shadow-black/15"
    >
      <div className="px-2.5 pb-1 pt-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
          Commands
        </span>
      </div>
      <div className="max-h-52 overflow-y-auto px-1 pb-1">
        {filtered.map((cmd, i) => (
          <button
            key={cmd.name}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd.label);
            }}
            onMouseEnter={() => setSelectedIndex(i)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-75 ${
              i === selectedIndex
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
          >
            <span className="font-mono text-sm font-medium text-primary">
              {cmd.label}
            </span>
            <span className="text-sm text-muted-foreground/70">
              {cmd.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
