import React from "react";
import { Loader2, Users } from "lucide-react";

interface SubAgentCardProps {
  toolInput: Record<string, unknown>;
  toolResult?: { content: string; isError: boolean };
}

export default function SubAgentCard({
  toolInput,
  toolResult,
}: SubAgentCardProps) {
  const description =
    typeof toolInput.description === "string"
      ? toolInput.description
      : "Sub-agent task";
  const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";
  const subagentType =
    typeof toolInput.subagent_type === "string"
      ? toolInput.subagent_type
      : "general-purpose";
  const isRunning = !toolResult;
  const isError = toolResult?.isError ?? false;

  // Extract summary stats from result if available
  const resultSummary = React.useMemo(() => {
    if (!toolResult?.content || isError) return null;
    const text = toolResult.content;
    // Try to detect tool usage counts from result text
    const toolMatch = text.match(/(\d+)\s+tool\s+use/i);
    const lineMatch = text.match(
      /(\d+)\s+lines?\s+(?:changed|modified|written|added)/i,
    );
    return {
      toolCount: toolMatch ? parseInt(toolMatch[1], 10) : null,
      lineInfo: lineMatch ? lineMatch[0] : null,
    };
  }, [toolResult, isError]);

  return (
    <div className="my-0.5 overflow-hidden rounded-xl border border-primary/20 bg-primary/5 shadow-md shadow-primary/5">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary" />
        ) : (
          <Users
            className={`h-3.5 w-3.5 flex-shrink-0 ${isError ? "text-destructive" : "text-primary"}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {description}
            </span>
            <span className="rounded-full bg-primary/10 px-1.5 py-px text-xs text-primary/70">
              {subagentType}
            </span>
          </div>
          {prompt && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {prompt.slice(0, 120)}
              {prompt.length > 120 ? "..." : ""}
            </p>
          )}
        </div>
        {isRunning && (
          <span className="text-xs text-primary/60">Working...</span>
        )}
        {!isRunning && !isError && resultSummary?.toolCount && (
          <span className="text-xs text-muted-foreground/50">
            {resultSummary.toolCount} tool{" "}
            {resultSummary.toolCount === 1 ? "use" : "uses"}
          </span>
        )}
      </div>
      {toolResult && (
        <div
          className={`border-t px-3 py-2 ${isError ? "border-destructive/20 bg-destructive/5" : "border-primary/10"}`}
        >
          {isError && (
            <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-destructive">
              Error
            </div>
          )}
          <pre
            className={`max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm ${isError ? "text-destructive" : "text-muted-foreground"}`}
          >
            {toolResult.content.slice(0, 500)}
            {toolResult.content.length > 500 ? "\n..." : ""}
          </pre>
        </div>
      )}
    </div>
  );
}
