import React from "react";
import { FileText } from "lucide-react";

interface ToolDiffViewerProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  badge: "Edit" | "New" | "Patch";
}

const BADGE_STYLES: Record<ToolDiffViewerProps["badge"], string> = {
  Edit: "bg-blue-500/15 text-blue-400",
  New: "bg-green-500/15 text-green-400",
  Patch: "bg-orange-500/15 text-orange-400",
};

const MAX_DIFF_LINES = 200;

export default function ToolDiffViewer({ oldContent, newContent, filePath, badge }: ToolDiffViewerProps) {
  const diffLines = computeDiffLines(oldContent, newContent);
  const truncated = oldContent.split("\n").length > MAX_DIFF_LINES || newContent.split("\n").length > MAX_DIFF_LINES;

  return (
    <div className="overflow-hidden rounded-b-lg">
      <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-3 py-1.5">
        <FileText className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-[11px] text-muted-foreground">{filePath}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${BADGE_STYLES[badge]}`}>{badge}</span>
      </div>
      {truncated && (
        <div className="border-t border-border bg-yellow-500/10 px-3 py-1 text-[11px] text-yellow-400">
          Diff truncated — inputs exceed {MAX_DIFF_LINES} lines
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-xs">
          <tbody>
            {diffLines.map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type DiffLineType = "added" | "removed" | "context";

interface DiffLine {
  type: DiffLineType;
  content: string;
}

function DiffLine({ line }: { line: DiffLine }) {
  const { bg, text, prefix } = DIFF_LINE_STYLE[line.type];
  return (
    <tr className={bg}>
      <td className={`select-none whitespace-pre px-2 py-0 text-right ${text} opacity-50`} style={{ minWidth: "1.5rem" }}>
        {prefix}
      </td>
      <td className={`whitespace-pre-wrap break-all px-2 py-0 ${text}`}>{line.content || " "}</td>
    </tr>
  );
}

const DIFF_LINE_STYLE: Record<DiffLineType, { bg: string; text: string; prefix: string }> = {
  added: { bg: "bg-green-500/10", text: "text-green-400", prefix: "+" },
  removed: { bg: "bg-red-500/10", text: "text-red-400", prefix: "−" },
  context: { bg: "", text: "text-muted-foreground", prefix: " " },
};

function computeDiffLines(oldContent: string, newContent: string): DiffLine[] {
  if (!oldContent && newContent) {
    return newContent.split("\n").map((content) => ({ type: "added", content }));
  }
  if (oldContent && !newContent) {
    return oldContent.split("\n").map((content) => ({ type: "removed", content }));
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const lcs = computeLCS(oldLines, newLines);
  let oldIdx = 0;
  let newIdx = 0;
  let lcsIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (
      lcsIdx < lcs.length &&
      oldIdx < oldLines.length &&
      newIdx < newLines.length &&
      oldLines[oldIdx] === lcs[lcsIdx] &&
      newLines[newIdx] === lcs[lcsIdx]
    ) {
      result.push({ type: "context", content: oldLines[oldIdx] });
      oldIdx++;
      newIdx++;
      lcsIdx++;
    } else if (newIdx < newLines.length && (lcsIdx >= lcs.length || newLines[newIdx] !== lcs[lcsIdx])) {
      result.push({ type: "added", content: newLines[newIdx] });
      newIdx++;
    } else if (oldIdx < oldLines.length) {
      result.push({ type: "removed", content: oldLines[oldIdx] });
      oldIdx++;
    }
  }

  return result;
}

function computeLCS(a: string[], b: string[]): string[] {
  // Cap array sizes to avoid O(n²) memory on large diffs
  const maxLines = 200;
  const aSlice = a.slice(0, maxLines);
  const bSlice = b.slice(0, maxLines);
  const m = aSlice.length;
  const n = bSlice.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aSlice[i - 1] === bSlice[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (aSlice[i - 1] === bSlice[j - 1]) {
      lcs.unshift(aSlice[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return lcs;
}
