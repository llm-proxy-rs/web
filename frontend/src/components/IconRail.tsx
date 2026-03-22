import React from "react";
import {
  FolderOpen,
  LogOut,
  MessageSquare,
  Moon,
  RotateCcw,
  Settings,
  Sun,
  Terminal,
} from "lucide-react";
import type { ViewTab } from "../types";

interface IconRailProps {
  activeTab: ViewTab;
  onTabChange: (tab: ViewTab) => void;
  hasUserRootfs: boolean;
  csrfFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  onSettingsOpen: () => void;
  onFilesOpen: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

export default function IconRail({
  activeTab,
  onTabChange,
  hasUserRootfs,
  csrfFetch,
  onSettingsOpen,
  onFilesOpen,
  darkMode,
  onToggleDarkMode,
}: IconRailProps) {
  return (
    <div className="hidden w-12 flex-col items-center gap-1 border-r border-border bg-card py-3 md:flex">
      <NavButton
        active={activeTab === "chat"}
        title="Chat"
        onClick={() => onTabChange("chat")}
      >
        <MessageSquare className="h-4 w-4" />
      </NavButton>
      <NavButton
        active={activeTab === "terminal"}
        title="Terminal"
        onClick={() => onTabChange("terminal")}
      >
        <Terminal className="h-4 w-4" />
      </NavButton>
      <NavButton title="Files" onClick={onFilesOpen}>
        <FolderOpen className="h-4 w-4" />
      </NavButton>

      <div className="mt-auto flex flex-col items-center gap-1">
        {hasUserRootfs && <ResetButton csrfFetch={csrfFetch} />}
        <NavButton
          title={darkMode ? "Light mode" : "Dark mode"}
          onClick={onToggleDarkMode}
        >
          {darkMode ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </NavButton>
        <NavButton title="Settings" onClick={onSettingsOpen}>
          <Settings className="h-4 w-4" />
        </NavButton>
        <NavButton
          title="Sign out"
          onClick={async () => {
            await csrfFetch("/logout", { method: "POST" });
            window.location.href = "/login";
          }}
        >
          <LogOut className="h-4 w-4" />
        </NavButton>
      </div>
    </div>
  );
}

function NavButton({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`relative flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150 ${
        active
          ? "bg-primary/15 text-primary shadow-sm shadow-primary/10 ring-1 ring-primary/20"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      {children}
      {active && (
        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-primary" />
      )}
    </button>
  );
}

function ResetButton({
  csrfFetch,
}: {
  csrfFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}) {
  const [open, setOpen] = React.useState(false);

  const handleReset = React.useCallback(async () => {
    const res = await csrfFetch("/rootfs/delete", {
      method: "POST",
    });
    if (res.ok || res.status === 303) {
      // Clear cached conversations and messages so they don't reappear after reset
      const keysToRemove = Object.keys(localStorage).filter(
        (k) =>
          k.startsWith("chat_messages_") ||
          k.startsWith("conversations_") ||
          k.startsWith("chat_running_task_"),
      );
      keysToRemove.forEach((k) => localStorage.removeItem(k));
      window.location.href = "/";
    }
  }, [csrfFetch]);

  return (
    <>
      <NavButton title="Reset environment" onClick={() => setOpen(true)}>
        <RotateCcw className="h-4 w-4" />
      </NavButton>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-base font-semibold text-foreground">
              Reset Environment?
            </h3>
            <p className="mb-1 text-sm text-muted-foreground">
              This will permanently delete all your files and reset your
              workspace to a clean state.
            </p>
            <p className="mb-6 text-sm font-medium text-destructive">
              Please back up your files before proceeding. This cannot be
              undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="rounded-xl bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground shadow-sm hover:opacity-90"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
