import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

interface Skill {
  name: string;
  content: string;
}

interface SkillsPanelProps {
  csrfFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

export default function SkillsPanel({ csrfFetch }: SkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formContent, setFormContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/skills");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSkills(await res.json());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resetForm = useCallback(() => {
    setFormName("");
    setFormContent("");
    setShowForm(false);
    setSaveError(null);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!formName.trim() || !formContent.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await csrfFetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: formName.trim(), content: formContent }),
      });
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      resetForm();
      await loadSkills();
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }, [formName, formContent, csrfFetch, loadSkills, resetForm]);

  const handleDelete = useCallback(
    async (name: string) => {
      setDeleting(name);
      try {
        const res = await csrfFetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadSkills();
      } catch (err) {
        setError(String(err));
      } finally {
        setDeleting(null);
      }
    },
    [csrfFetch, loadSkills],
  );

  if (loading) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {skills.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">
          No custom skills. Create one to automate common workflows.
        </p>
      )}

      {skills.map((s) => (
        <div
          key={s.name}
          className="overflow-hidden rounded-lg border border-border"
        >
          <div className="flex items-center justify-between px-3 py-2">
            <button
              type="button"
              onClick={() => setExpanded(expanded === s.name ? null : s.name)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="text-sm font-medium text-foreground">
                /{s.name}
              </div>
            </button>
            <button
              onClick={() => handleDelete(s.name)}
              disabled={deleting === s.name}
              className="ml-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
              title="Delete skill"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {expanded === s.name && (
            <div className="border-t border-border bg-muted/20 px-3 py-2">
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                {s.content}
              </pre>
            </div>
          )}
        </div>
      ))}

      {showForm ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <input
            type="text"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Skill name (e.g. deploy)"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
          <textarea
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            placeholder={
              "---\ntype: skill\nwhenToUse: |\n  Use when...\n---\n\nSkill instructions here..."
            }
            rows={8}
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
          {saveError && <p className="text-sm text-red-400">{saveError}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={resetForm}
              className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!formName.trim() || !formContent.trim() || saving}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
            >
              {saving ? "Saving..." : "Create Skill"}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          Create Skill
        </button>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
