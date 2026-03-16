import React, { useCallback, useEffect, useState } from "react";
import { Check, Key, X } from "lucide-react";
import { useSse } from "../contexts/SseContext";

interface SettingsData {
  uses_bedrock: boolean;
  has_api_key: boolean;
  base_url: string | null;
}

interface SettingsPanelProps {
  onClose: () => void;
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { csrfToken } = useSse();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<"success" | "error" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/settings", { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as SettingsData;
      setSettings(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLoadError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const abortController = new AbortController();
    loadSettings(abortController.signal);
    return () => abortController.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      setSaveResult("success");
      setApiKey("");
      await loadSettings();
    } catch {
      setSaveResult("error");
    } finally {
      setSaving(false);
    }
  }, [apiKey, csrfToken, loadSettings]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Settings</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4">
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : loadError ? (
            <div className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-sm text-red-300">
              {loadError}
            </div>
          ) : settings ? (
            <div className="space-y-4">
              {settings.uses_bedrock ? (
                <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  Using AWS Bedrock credentials (IAM-managed)
                </div>
              ) : (
                <ApiKeySection
                  hasApiKey={settings.has_api_key}
                  apiKey={apiKey}
                  onApiKeyChange={setApiKey}
                  onSave={handleSave}
                  saving={saving}
                  saveResult={saveResult}
                />
              )}
              {settings.base_url && (
                <div className="text-xs text-muted-foreground">
                  Base URL:{" "}
                  <span className="font-mono text-foreground">{settings.base_url}</span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ApiKeySection({
  hasApiKey,
  apiKey,
  onApiKeyChange,
  onSave,
  saving,
  saveResult,
}: {
  hasApiKey: boolean;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onSave: () => void;
  saving: boolean;
  saveResult: "success" | "error" | null;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Key className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">API Key</span>
        {hasApiKey && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
            <Check className="h-3 w-3" />
            Set
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave();
          }}
          placeholder={hasApiKey ? "Enter new key to update…" : "sk-ant-…"}
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
        />
        <button
          onClick={onSave}
          disabled={!apiKey.trim() || saving}
          className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {saveResult === "success" && (
        <p className="text-xs text-emerald-500">API key saved successfully.</p>
      )}
      {saveResult === "error" && (
        <p className="text-xs text-red-400">Failed to save. Please try again.</p>
      )}
    </div>
  );
}
