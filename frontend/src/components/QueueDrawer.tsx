import React, { useState } from "react";
import { ChevronDown, X } from "lucide-react";

interface QueueDrawerProps {
  messages: string[];
  onRemove: (index: number) => void;
  onClear: () => void;
}

export default function QueueDrawer({
  messages,
  onRemove,
  onClear,
}: QueueDrawerProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (messages.length === 0) return null;

  return (
    <div className="flex-shrink-0 border-t border-border bg-card/70 px-3 pt-2">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
            />
            Queued messages ({messages.length})
          </button>
          {messages.length > 1 && (
            <button
              type="button"
              onClick={onClear}
              className="text-xs text-muted-foreground/60 hover:text-destructive"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Queue items */}
        {!collapsed && (
          <div
            data-testid="queue-list"
            className="mt-1.5 mb-1 flex max-h-32 flex-col gap-1 overflow-y-auto"
          >
            {messages.map((msg, i) => (
              <div
                key={`${i}-${msg.slice(0, 20)}`}
                className="fade-in-up flex items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
                  {msg}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  title="Remove from queue"
                  className="flex-shrink-0 text-muted-foreground/50 hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
