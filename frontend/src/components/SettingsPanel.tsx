import React, { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { useSse } from "../contexts/SseContext";
import type { UiPreferences } from "../hooks/useUiPreferences";

interface SettingsData {
  uses_bedrock: boolean;
  has_api_key: boolean;
  base_url: string | null;
  gateway_configured: boolean;
}

interface SettingsPanelProps {
  onClose: () => void;
  preferences: UiPreferences;
  onTogglePreference: <K extends keyof UiPreferences>(
    key: K,
    value: UiPreferences[K],
  ) => void;
}

type Tab = "general" | "preferences";

export default function SettingsPanel({
  onClose,
  preferences,
  onTogglePreference,
}: SettingsPanelProps) {
  const { csrfFetch } = useSse();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [saveResult, setSaveResult] = useState<"success" | "error" | null>(
    null,
  );
  const [renewResult, setRenewResult] = useState<"success" | "error" | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("general");

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/settings", { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SettingsData;
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
      const res = await csrfFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      setSaveResult("success");
      setApiKey("");
      await loadSettings();
    } catch (e) {
      console.error("Failed to save API key", e);
      setSaveResult("error");
    } finally {
      setSaving(false);
    }
  }, [apiKey, csrfFetch, loadSettings]);

  const handleRenewApiKey = useCallback(async () => {
    setRenewing(true);
    setRenewResult(null);
    try {
      const res = await csrfFetch("/api/renew-gateway-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      const data = await res.json();
      if (data.redirect) {
        // Need to re-auth through gateway OAuth — only allow https redirects
        try {
          const url = new URL(data.redirect);
          if (url.protocol !== "https:") {
            throw new Error("Insecure redirect blocked");
          }
          window.location.href = url.href;
        } catch (urlErr) {
          throw urlErr instanceof Error && urlErr.message.includes("blocked")
            ? urlErr
            : new Error("Invalid redirect URL");
        }
        return;
      }
      setRenewResult("success");
      await loadSettings();
    } catch (e) {
      console.error("Failed to renew API key", e);
      setRenewResult("error");
    } finally {
      setRenewing(false);
    }
  }, [csrfFetch, loadSettings]);

  const TABS: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "preferences", label: "Preferences" },
  ];

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
          <h2 className="text-base font-semibold text-foreground">Settings</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="p-4">
          {activeTab === "general" && (
            <>
              {loading ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  Loading…
                </div>
              ) : loadError ? (
                <div className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-sm text-red-300">
                  {loadError}
                </div>
              ) : settings ? (
                <div className="space-y-4">
                  {!settings.uses_bedrock && settings.gateway_configured ? (
                    <RenewApiKeySection
                      hasApiKey={settings.has_api_key}
                      renewing={renewing}
                      renewResult={renewResult}
                      onRenew={handleRenewApiKey}
                    />
                  ) : !settings.uses_bedrock ? (
                    <ApiKeySection
                      hasApiKey={settings.has_api_key}
                      apiKey={apiKey}
                      onApiKeyChange={setApiKey}
                      onSave={handleSave}
                      saving={saving}
                      saveResult={saveResult}
                    />
                  ) : null}
                  {!settings.uses_bedrock && settings.base_url && (
                    <div className="text-sm text-muted-foreground">
                      Base URL:{" "}
                      <span className="font-mono text-foreground">
                        {settings.base_url}
                      </span>
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}

          {activeTab === "preferences" && (
            <div className="space-y-1">
              {QUICK_TOGGLES.map((t) => (
                <label
                  key={t.key}
                  className="flex items-center justify-between rounded-lg px-2 py-2.5"
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
                    onClick={() =>
                      onTogglePreference(t.key, !preferences[t.key])
                    }
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
          )}
        </div>
      </div>
    </div>
  );
}

const QUICK_TOGGLES: {
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
        <span className="text-sm font-semibold text-foreground">API Key</span>
        {hasApiKey && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
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
        <p className="text-sm text-emerald-500">API key saved successfully.</p>
      )}
      {saveResult === "error" && (
        <p className="text-sm text-red-400">
          Failed to save. Please try again.
        </p>
      )}
    </div>
  );
}

function RenewApiKeySection({
  hasApiKey,
  renewing,
  renewResult,
  onRenew,
}: {
  hasApiKey: boolean;
  renewing: boolean;
  renewResult: "success" | "error" | null;
  onRenew: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">API Key</span>
        {hasApiKey && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
            <Check className="h-3 w-3" />
            Set
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Your API key is managed automatically. Use the button below to generate
        a new one.
      </p>
      <button
        onClick={onRenew}
        disabled={renewing}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
      >
        {renewing ? "Renewing…" : "Renew API Key"}
      </button>
      {renewResult === "success" && (
        <p className="text-sm text-emerald-500">
          API key renewed successfully.
        </p>
      )}
      {renewResult === "error" && (
        <p className="text-sm text-red-400">
          Failed to renew. Please try again.
        </p>
      )}
    </div>
  );
}
