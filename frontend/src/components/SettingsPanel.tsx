import React, { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Plus, Trash2, X } from "lucide-react";
import { useSse } from "../contexts/SseContext";
import type { UiPreferences } from "../hooks/useUiPreferences";
import type { McpServer } from "../types";

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

type Tab = "general" | "preferences" | "mcp";

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
    { id: "mcp", label: "MCP Servers" },
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
          {activeTab === "mcp" && <McpServersSection csrfFetch={csrfFetch} />}
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

function McpServersSection({
  csrfFetch,
}: {
  csrfFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formHeaders, setFormHeaders] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // OAuth state
  const [detecting, setDetecting] = useState(false);
  const [oauthDetected, setOauthDetected] = useState(false);
  const [oauthMetadata, setOauthMetadata] = useState<{
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
  } | null>(null);
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [authorizing, setAuthorizing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  const loadServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp-servers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setServers(await res.json());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadServers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resetForm = useCallback(() => {
    setFormName("");
    setFormUrl("");
    setFormHeaders("");
    setShowForm(false);
    setSaveError(null);
    setOauthDetected(false);
    setOauthMetadata(null);
    setOauthClientId("");
    setOauthClientSecret("");
    setRegError(null);
  }, []);

  // Listen for OAuth popup result via BroadcastChannel
  useEffect(() => {
    const errorMessages: Record<string, string> = {
      state_mismatch: "OAuth failed: state mismatch. Please try again.",
      token_exchange: "OAuth failed: token exchange failed.",
      config_read: "OAuth failed: could not read VM config.",
      config_parse: "OAuth failed: could not parse VM config.",
      name_exists: "OAuth failed: server name already exists.",
    };

    const ch = new BroadcastChannel("mcp_oauth");
    ch.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== "mcp_oauth") return;
      if (event.data.result === "success") {
        resetForm();
        loadServers();
        setAuthorizing(false);
      } else {
        const reason = event.data.reason as string | undefined;
        setSaveError(
          reason
            ? errorMessages[reason] || `OAuth failed: ${reason}`
            : "OAuth failed. Please try again.",
        );
        setAuthorizing(false);
      }
    };
    return () => ch.close();
  }, [loadServers, resetForm]);

  const parseHeaders = (text: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        headers[trimmed.slice(0, eqIdx).trim()] = trimmed
          .slice(eqIdx + 1)
          .trim();
      }
    }
    return headers;
  };

  const handleDetectAuth = useCallback(async () => {
    if (!formUrl.trim()) return;
    setDetecting(true);
    setSaveError(null);
    setRegError(null);
    setOauthDetected(false);
    setOauthMetadata(null);
    setOauthClientId("");
    setOauthClientSecret("");
    try {
      const res = await fetch(
        `/api/mcp-servers/oauth-discover?url=${encodeURIComponent(formUrl.trim())}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.oauth && data.metadata) {
        setOauthDetected(true);
        setOauthMetadata(data.metadata);

        // Attempt Dynamic Client Registration
        if (data.metadata.registration_endpoint) {
          try {
            const regRes = await csrfFetch("/api/mcp-servers/oauth-register", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                registration_endpoint: data.metadata.registration_endpoint,
                client_name: "Claude Web",
                redirect_uri: `${window.location.origin}/callback/mcp-oauth`,
                scope: data.metadata.scopes_supported?.join(" ") ?? undefined,
                token_endpoint_auth_methods_supported:
                  data.metadata.token_endpoint_auth_methods_supported ??
                  undefined,
              }),
            });
            if (regRes.ok) {
              const regData = await regRes.json();
              setOauthClientId(regData.client_id);
              if (regData.client_secret) {
                setOauthClientSecret(regData.client_secret);
              }
            } else {
              const errText = await regRes.text();
              setRegError(
                errText || `Registration failed: HTTP ${regRes.status}`,
              );
            }
          } catch (regErr) {
            setRegError(`Registration request failed: ${String(regErr)}`);
          }
        }
      }
    } catch (err) {
      setSaveError(`Auth detection failed: ${String(err)}`);
    } finally {
      setDetecting(false);
    }
  }, [formUrl, csrfFetch]);

  const handleAutoRegister = useCallback(async () => {
    if (!oauthMetadata?.registration_endpoint) return;
    setRegistering(true);
    setSaveError(null);
    try {
      const regRes = await csrfFetch("/api/mcp-servers/oauth-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          registration_endpoint: oauthMetadata.registration_endpoint,
          client_name: "Claude Web",
          redirect_uri: `${window.location.origin}/callback/mcp-oauth`,
          scope: oauthMetadata.scopes_supported?.join(" ") ?? undefined,
          token_endpoint_auth_methods_supported:
            oauthMetadata.token_endpoint_auth_methods_supported ?? undefined,
        }),
      });
      if (!regRes.ok) {
        const text = await regRes.text();
        throw new Error(text || `HTTP ${regRes.status}`);
      }
      const regData = await regRes.json();
      setOauthClientId(regData.client_id);
      if (regData.client_secret) {
        setOauthClientSecret(regData.client_secret);
      }
    } catch (err) {
      setSaveError(
        `Auto-registration failed: ${String(err)}. Enter a Client ID manually.`,
      );
    } finally {
      setRegistering(false);
    }
  }, [oauthMetadata, csrfFetch]);

  const handleOAuthAuthorize = useCallback(async () => {
    if (
      !oauthMetadata ||
      !formName.trim() ||
      !formUrl.trim() ||
      !oauthClientId.trim()
    )
      return;
    setAuthorizing(true);
    setSaveError(null);
    try {
      const startRes = await csrfFetch("/api/mcp-servers/oauth-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authorization_endpoint: oauthMetadata.authorization_endpoint,
          token_endpoint: oauthMetadata.token_endpoint,
          client_id: oauthClientId.trim(),
          client_secret: oauthClientSecret.trim() || undefined,
          scopes: oauthMetadata.scopes_supported?.join(" ") ?? "",
          redirect_uri: `${window.location.origin}/callback/mcp-oauth`,
          mcp_url: formUrl.trim(),
          server_name: formName.trim(),
        }),
      });
      if (!startRes.ok)
        throw new Error((await startRes.text()) || `HTTP ${startRes.status}`);
      const startData = await startRes.json();
      if (startData.redirect) {
        const redirectUrl = new URL(startData.redirect);
        if (redirectUrl.protocol !== "https:")
          throw new Error("Insecure redirect blocked");
        const w = 600;
        const h = 700;
        const left = window.screenX + (window.outerWidth - w) / 2;
        const top = window.screenY + (window.outerHeight - h) / 2;
        const popup = window.open(
          redirectUrl.href,
          "mcp_oauth_popup",
          `width=${w},height=${h},left=${left},top=${top}`,
        );
        if (!popup) {
          throw new Error("Popup blocked. Please allow popups for this site.");
        }
        // Poll for popup close — clears "Redirecting…" if user closes popup manually.
        // BroadcastChannel handles the actual result communication.
        const timer = setInterval(() => {
          if (popup.closed) {
            clearInterval(timer);
            setAuthorizing(false);
          }
        }, 500);
      }
    } catch (err) {
      setSaveError(String(err));
      setAuthorizing(false);
    }
  }, [
    oauthMetadata,
    formName,
    formUrl,
    oauthClientId,
    oauthClientSecret,
    csrfFetch,
  ]);

  const handleAdd = useCallback(async () => {
    if (!formName.trim() || !formUrl.trim()) return;
    if (servers.some((s) => s.name === formName.trim())) {
      setSaveError("Server name already exists");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const headers = parseHeaders(formHeaders);
      const res = await csrfFetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName.trim(),
          url: formUrl.trim(),
          headers,
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      resetForm();
      await loadServers();
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }, [
    formName,
    formUrl,
    formHeaders,
    servers,
    csrfFetch,
    loadServers,
    resetForm,
  ]);

  const handleDelete = useCallback(
    async (name: string) => {
      setDeleting(name);
      try {
        const res = await csrfFetch(
          `/api/mcp-servers/${encodeURIComponent(name)}`,
          {
            method: "DELETE",
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadServers();
      } catch (err) {
        setError(String(err));
      } finally {
        setDeleting(null);
      }
    },
    [csrfFetch, loadServers],
  );

  if (loading) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (error && servers.length === 0) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-sm text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {servers.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">
          No MCP servers configured.
        </p>
      )}

      {servers.map((s) => (
        <div
          key={s.name}
          className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground truncate">
              {s.name}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {s.url}
            </div>
          </div>
          {s.name !== "gemini-websearch" && (
            <button
              onClick={() => handleDelete(s.name)}
              disabled={deleting === s.name}
              className="ml-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
              title="Remove server"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}

      {showForm ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <input
            type="text"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Server name"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={formUrl}
              onChange={(e) => {
                setFormUrl(e.target.value);
                setOauthDetected(false);
                setOauthMetadata(null);
              }}
              placeholder="https://example.com/mcp"
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
            <button
              onClick={handleDetectAuth}
              disabled={!formUrl.trim() || detecting}
              className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              title="Detect if this server requires OAuth"
            >
              {detecting ? "Checking…" : "Detect Auth"}
            </button>
          </div>

          {oauthDetected && oauthMetadata ? (
            <div className="space-y-2">
              {oauthClientId ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
                  <p className="text-sm font-medium text-foreground">
                    OAuth ready
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Client registered automatically. Click below to authorize.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
                  <p className="text-sm font-medium text-foreground">
                    OAuth required
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {regError
                      ? "Auto-registration failed. Create an OAuth app in the provider's developer settings and enter the Client ID below."
                      : "Auto-registration not supported by this server. Create an OAuth app in the provider's developer settings and enter the Client ID below."}{" "}
                    Set the redirect URI to:{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                      {typeof window !== "undefined"
                        ? `${window.location.origin}/callback/mcp-oauth`
                        : "/callback/mcp-oauth"}
                    </code>
                  </p>
                  {regError && (
                    <p className="mt-1 text-xs text-red-400">{regError}</p>
                  )}
                </div>
              )}
              {!oauthClientId && (
                <>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={oauthClientId}
                      onChange={(e) => setOauthClientId(e.target.value)}
                      placeholder="Client ID"
                      className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
                    />
                    {oauthMetadata.registration_endpoint && (
                      <button
                        onClick={handleAutoRegister}
                        disabled={registering}
                        className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                        title="Retry auto-registration"
                      >
                        {registering ? "Trying…" : "Retry"}
                      </button>
                    )}
                  </div>
                  <input
                    type="password"
                    value={oauthClientSecret}
                    onChange={(e) => setOauthClientSecret(e.target.value)}
                    placeholder="Client Secret (optional)"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
                  />
                </>
              )}
              <button
                onClick={handleOAuthAuthorize}
                disabled={
                  !formName.trim() || !oauthClientId.trim() || authorizing
                }
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {authorizing ? "Redirecting…" : "Authorize with OAuth"}
              </button>
            </div>
          ) : (
            <>
              <textarea
                value={formHeaders}
                onChange={(e) => setFormHeaders(e.target.value)}
                placeholder={"Authorization=Bearer token\nX-API-Key=your-key"}
                rows={2}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20 resize-none"
              />
              <p className="text-xs text-muted-foreground">
                Headers (Key=Value per line), or use Detect Auth for OAuth
                servers.
              </p>
            </>
          )}

          {saveError && <p className="text-sm text-red-400">{saveError}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={resetForm}
              className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            {!oauthDetected && (
              <button
                onClick={handleAdd}
                disabled={!formName.trim() || !formUrl.trim() || saving}
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Server
        </button>
      )}
    </div>
  );
}
