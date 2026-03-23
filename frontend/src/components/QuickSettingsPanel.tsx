import React from "react";
import { X } from "lucide-react";
import type { UiPreferences } from "../hooks/useUiPreferences";

interface QuickSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  preferences: UiPreferences;
  onToggle: <K extends keyof UiPreferences>(
    key: K,
    value: UiPreferences[K],
  ) => void;
}

const TOGGLES: {
  key: keyof UiPreferences;
  label: string;
  description: string;
}[] = [
  {
    key: "autoExpandTools",
    label: "Auto-expand tools",
    description: "Expand tool cards by default",
  },
  {
    key: "showThinking",
    label: "Show thinking",
    description: "Show thinking blocks",
  },
  {
    key: "autoScrollToBottom",
    label: "Auto-scroll",
    description: "Scroll to bottom on new messages",
  },
];

export default function QuickSettingsPanel({
  open,
  onClose,
  preferences,
  onToggle,
}: QuickSettingsPanelProps) {
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        data-testid="quick-settings-backdrop"
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-72 border-l border-border bg-card shadow-xl">
        <div className="flex h-11 items-center justify-between border-b border-border px-4">
          <span className="text-sm font-semibold text-foreground">
            Quick Settings
          </span>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1 p-4">
          {TOGGLES.map((t) => (
            <label
              key={t.key}
              className="flex items-center justify-between rounded-lg px-2 py-3"
            >
              <div>
                <div className="text-sm font-medium text-foreground">
                  {t.label}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t.description}
                </div>
              </div>
              <button
                role="switch"
                aria-checked={preferences[t.key]}
                onClick={() => onToggle(t.key, !preferences[t.key])}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
                  preferences[t.key] ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                    preferences[t.key] ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}
