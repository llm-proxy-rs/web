import React from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
} from "lucide-react";
import type { AgentTask } from "../types";

interface TaskWidgetProps {
  tasks: AgentTask[];
}

const MAX_VISIBLE = 5;

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

const STATUS_CONFIG = {
  pending: {
    icon: Circle,
    color: "text-muted-foreground",
  },
  in_progress: {
    icon: Loader2,
    color: "text-primary",
    animate: true,
  },
  completed: {
    icon: CheckCircle2,
    color: "text-emerald-500",
  },
} as const;

export default function TaskWidget({ tasks }: TaskWidgetProps) {
  const [userCollapsed, setUserCollapsed] = React.useState<boolean | null>(
    null,
  );

  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const allDone = tasks.length > 0 && inProgress === 0 && pending === 0;

  // Auto-collapse when all done, auto-expand when work resumes.
  // User's manual toggle overrides until the active/done state changes.
  const collapsed = userCollapsed ?? allDone;

  // Reset user override when allDone state changes
  const prevAllDone = React.useRef(allDone);
  React.useEffect(() => {
    if (prevAllDone.current !== allDone) {
      prevAllDone.current = allDone;
      setUserCollapsed(null);
    }
  }, [allDone]);

  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
  );
  const visible = sorted.slice(0, MAX_VISIBLE);
  const overflow = sorted.length - MAX_VISIBLE;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div
        className={`rounded-xl border shadow-sm ${allDone ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/60 bg-card/80"}`}
      >
        {/* Header */}
        <button
          type="button"
          onClick={() => setUserCollapsed(!collapsed)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/30"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
          )}
          <span className="text-xs font-medium text-muted-foreground">
            Tasks
          </span>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
            {inProgress > 0 && (
              <span className="flex items-center gap-0.5">
                <Loader2 className="h-2.5 w-2.5 animate-spin text-primary" />
                {inProgress}
              </span>
            )}
            {pending > 0 && (
              <span className="flex items-center gap-0.5">
                <Circle className="h-2.5 w-2.5 text-muted-foreground" />
                {pending}
              </span>
            )}
            {completed > 0 && (
              <span className="flex items-center gap-0.5">
                <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" />
                {completed}
              </span>
            )}
            {allDone && <span className="text-emerald-500">All done</span>}
          </div>
        </button>

        {/* Task list */}
        {!collapsed && (
          <div className="border-t border-border/40 px-3 py-1">
            {visible.map((task) => {
              const config =
                STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending;
              const Icon = config.icon;
              return (
                <div key={task.id} className="flex items-center gap-2 py-0.5">
                  <Icon
                    className={`h-3 w-3 flex-shrink-0 ${config.color} ${"animate" in config && config.animate ? "animate-spin" : ""}`}
                  />
                  <span className="font-mono text-[10px] text-foreground/40">
                    #{task.id}
                  </span>
                  <span className="min-w-0 truncate text-xs text-foreground/80">
                    {task.activeForm && task.status === "in_progress"
                      ? task.activeForm
                      : task.subject}
                  </span>
                  {task.blockedBy && task.blockedBy.length > 0 && (
                    <span className="ml-auto flex-shrink-0 text-[10px] text-amber-500">
                      blocked
                    </span>
                  )}
                </div>
              );
            })}
            {overflow > 0 && (
              <div className="py-0.5 text-[10px] text-muted-foreground/50">
                +{overflow} more
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
