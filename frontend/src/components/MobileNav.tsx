import React from "react";
import { Clock, FolderOpen, MessageSquare, Terminal } from "lucide-react";
import type { ViewTab } from "../types";

interface MobileNavProps {
  activeTab: ViewTab;
  onTabChange: (tab: ViewTab) => void;
  onToggleSidebar?: () => void;
  onFilesOpen?: () => void;
}

export default function MobileNav({
  activeTab,
  onTabChange,
  onToggleSidebar,
  onFilesOpen,
}: MobileNavProps) {
  return (
    <div
      data-testid="mobile-nav"
      className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-border bg-background/80 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <button
        onClick={() => onTabChange("chat")}
        className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${
          activeTab === "chat" ? "text-primary" : "text-muted-foreground"
        }`}
      >
        <MessageSquare className="h-5 w-5" />
        <span>Chat</span>
      </button>
      <button
        onClick={() => onToggleSidebar?.()}
        className="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-muted-foreground"
      >
        <Clock className="h-5 w-5" />
        <span>History</span>
      </button>
      <button
        onClick={() => onTabChange("terminal")}
        className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${
          activeTab === "terminal" ? "text-primary" : "text-muted-foreground"
        }`}
      >
        <Terminal className="h-5 w-5" />
        <span>Terminal</span>
      </button>
      <button
        onClick={() => onFilesOpen?.()}
        className="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-muted-foreground"
      >
        <FolderOpen className="h-5 w-5" />
        <span>Files</span>
      </button>
    </div>
  );
}
