import { useCallback, useState } from "react";
import { pickValid, safeJsonParse } from "../utils/safeJson";

export interface UiPreferences {
  autoExpandTools: boolean;
  showThinking: boolean;
  autoScrollToBottom: boolean;
}

const STORAGE_KEY = "ui_preferences";

const DEFAULTS: UiPreferences = {
  autoExpandTools: false,
  showThinking: true,
  autoScrollToBottom: true,
};

function load(): UiPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return pickValid(safeJsonParse(raw), DEFAULTS);
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

export function useUiPreferences() {
  const [preferences, setPreferences] = useState<UiPreferences>(load);

  const setPreference = useCallback(
    <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) => {
      setPreferences((prev) => {
        const next = { ...prev, [key]: value };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    [],
  );

  return { preferences, setPreference };
}
