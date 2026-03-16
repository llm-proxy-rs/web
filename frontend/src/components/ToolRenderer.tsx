import React from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { ToolResult } from "../types";
import ToolDiffViewer from "./ToolDiffViewer";

interface ToolRendererProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: ToolResult;
}

export default function ToolRenderer({ toolName, toolInput, toolResult }: ToolRendererProps) {
  return (
    <div className="my-0.5 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <ToolHeader toolName={toolName} toolInput={toolInput} toolResult={toolResult} />
    </div>
  );
}

type DiffBadge = "Edit" | "New" | "Patch";

function isEditTool(toolName: string): boolean {
  return toolName === "Edit" || toolName === "Write" || toolName === "ApplyPatch";
}

function getDiffProps(
  toolName: string,
  input: Record<string, unknown>,
): { oldContent: string; newContent: string; filePath: string; badge: DiffBadge } | null {
  if (toolName === "Edit") {
    return {
      filePath: String(input.file_path ?? ""),
      oldContent: String(input.old_string ?? ""),
      newContent: String(input.new_string ?? ""),
      badge: "Edit",
    };
  }
  if (toolName === "Write") {
    return {
      filePath: String(input.file_path ?? ""),
      oldContent: "",
      newContent: String(input.content ?? ""),
      badge: "New",
    };
  }
  if (toolName === "ApplyPatch") {
    return {
      filePath: String(input.file_path ?? input.path ?? ""),
      oldContent: String(input.old ?? input.original ?? ""),
      newContent: String(input.new ?? input.patched ?? ""),
      badge: "Patch",
    };
  }
  return null;
}

function ToolHeader({
  toolName,
  toolInput,
  toolResult,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: ToolResult;
}) {
  const diffProps = isEditTool(toolName) ? getDiffProps(toolName, toolInput) : null;
  const [open, setOpen] = React.useState(diffProps !== null);
  const summary = buildSummary(toolName, toolInput);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 active:bg-accent/70"
      >
        <Wrench className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
        <span className="flex-1 truncate text-xs">
          <span className="font-medium text-muted-foreground">{toolName}</span>
          {summary && (
            <span className="ml-2 font-mono text-[11px] text-foreground/60">{summary}</span>
          )}
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
        )}
      </button>

      {open && diffProps && (
        <ToolDiffViewer
          oldContent={diffProps.oldContent}
          newContent={diffProps.newContent}
          filePath={diffProps.filePath}
          badge={diffProps.badge}
        />
      )}
      {open && !diffProps && (
        <div className="border-t border-border px-3 py-2">
          <ToolInputBody toolName={toolName} toolInput={toolInput} />
        </div>
      )}
      {open && toolResult && !isEditTool(toolName) && <ToolResultView result={toolResult} />}
      {open && toolResult?.isError && isEditTool(toolName) && <ToolResultView result={toolResult} />}
    </div>
  );
}

function ToolInputBody({ toolName, toolInput }: { toolName: string; toolInput: Record<string, unknown> }) {
  if (toolName === "Bash" || toolName === "shell") return <BashInputBody toolInput={toolInput} />;
  if (toolName === "Grep")      return <GrepInputBody toolInput={toolInput} />;
  if (toolName === "Glob")      return <GlobInputBody toolInput={toolInput} />;
  if (toolName === "WebFetch")  return <WebFetchInputBody toolInput={toolInput} />;
  if (toolName === "WebSearch") return <WebSearchInputBody toolInput={toolInput} />;
  if (toolName === "TodoWrite" || toolName === "TodoRead") return <TodoInputBody toolInput={toolInput} />;
  return (
    <pre className="overflow-x-auto text-xs text-muted-foreground">
      {JSON.stringify(toolInput, null, 2)}
    </pre>
  );
}

function BashInputBody({ toolInput }: { toolInput: Record<string, unknown> }) {
  const cmd = toolInput.command ?? toolInput.cmd;
  const desc = toolInput.description;
  return (
    <div>
      {typeof cmd === "string" && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground/80">
          {cmd}
        </pre>
      )}
      {typeof desc === "string" && (
        <p className="mt-1 text-[11px] text-muted-foreground">{desc}</p>
      )}
    </div>
  );
}

function GrepInputBody({ toolInput }: { toolInput: Record<string, unknown> }) {
  const pattern = toolInput.pattern;
  const path = toolInput.path ?? toolInput.glob;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {typeof pattern === "string" && (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/80">/{pattern}/</code>
      )}
      {typeof path === "string" && (
        <span className="font-mono text-muted-foreground">{path}</span>
      )}
    </div>
  );
}

function GlobInputBody({ toolInput }: { toolInput: Record<string, unknown> }) {
  const pattern = toolInput.pattern;
  const path = toolInput.path;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {typeof pattern === "string" && (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/80">{pattern}</code>
      )}
      {typeof path === "string" && (
        <span className="font-mono text-muted-foreground">{path}</span>
      )}
    </div>
  );
}

function WebFetchInputBody({ toolInput }: { toolInput: Record<string, unknown> }) {
  const url = toolInput.url;
  return typeof url === "string" ? (
    <span className="break-all text-xs text-muted-foreground">{url}</span>
  ) : null;
}

function WebSearchInputBody({ toolInput }: { toolInput: Record<string, unknown> }) {
  const query = toolInput.query;
  return typeof query === "string" ? (
    <span className="text-xs text-muted-foreground">{query}</span>
  ) : null;
}

function TodoInputBody({ toolInput }: { toolInput: Record<string, unknown> }) {
  const todos = toolInput.todos;
  if (Array.isArray(todos)) {
    return (
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {todos.slice(0, 5).map((todo, i) => (
          <li key={i} className="truncate">
            {typeof todo === "object" && todo !== null
              ? String((todo as Record<string, unknown>).content ?? JSON.stringify(todo))
              : String(todo)}
          </li>
        ))}
        {todos.length > 5 && (
          <li className="text-muted-foreground/50">+{todos.length - 5} more</li>
        )}
      </ul>
    );
  }
  return (
    <pre className="overflow-x-auto text-xs text-muted-foreground">
      {JSON.stringify(toolInput, null, 2)}
    </pre>
  );
}

function ToolResultView({ result }: { result: ToolResult }) {
  const [open, setOpen] = React.useState(false);
  const isLong = result.content.length > 200;

  return (
    <div className={`border-t border-border px-3 py-2 ${result.isError ? "bg-destructive/5" : "bg-muted/30"}`}>
      {result.isError && (
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-destructive">
          Error
        </div>
      )}
      {isLong ? (
        <div>
          <div className="relative overflow-hidden">
            <pre
              className={`whitespace-pre-wrap break-words font-mono text-xs ${
                result.isError ? "text-destructive" : "text-muted-foreground"
              } ${!open ? "max-h-24" : ""}`}
              style={{ overflow: open ? "auto" : "hidden" }}
            >
              {result.content}
            </pre>
            {!open && (
              <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent" />
            )}
          </div>
          <button
            onClick={() => setOpen((v) => !v)}
            className="mt-1 text-[10px] text-primary hover:underline"
          >
            {open ? "Show less" : "Show more"}
          </button>
        </div>
      ) : (
        <pre
          className={`whitespace-pre-wrap break-words font-mono text-xs ${
            result.isError ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {result.content}
        </pre>
      )}
    </div>
  );
}

function buildSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" || toolName === "shell") {
    const cmd = input.command ?? input.cmd;
    if (typeof cmd === "string") return cmd.slice(0, 80);
  }
  if (["Read", "Write", "Edit", "Glob"].includes(toolName)) {
    const path = input.file_path ?? input.path ?? input.pattern;
    if (typeof path === "string") return path.slice(0, 80);
  }
  if (toolName === "Grep") {
    const pattern = input.pattern;
    if (typeof pattern === "string") return `/${pattern}/`;
  }
  if (toolName === "WebFetch") {
    const url = input.url;
    if (typeof url === "string") return url.slice(0, 80);
  }
  if (toolName === "WebSearch") {
    const query = input.query;
    if (typeof query === "string") return query.slice(0, 80);
  }
  return "";
}
