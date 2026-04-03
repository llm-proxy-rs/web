import React from "react";
import { GitBranch } from "lucide-react";

interface WorktreeBadgeProps {
  name?: string;
}

export default function WorktreeBadge({ name }: WorktreeBadgeProps) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-500">
      <GitBranch className="h-3 w-3" />
      <span>Sandbox Mode</span>
      {name && <span className="font-mono text-amber-400/70">{name}</span>}
    </div>
  );
}
