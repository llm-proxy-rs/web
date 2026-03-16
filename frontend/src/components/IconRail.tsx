import React from "react";
import { FolderOpen, LogOut, MessageSquare, Moon, RotateCcw, Settings, Sun, Terminal } from "lucide-react";
import type { ViewTab } from "../types";

interface IconRailProps {
  activeTab: ViewTab;
  onTabChange: (tab: ViewTab) => void;
  hasUserRootfs: boolean;
  csrfToken: string;
  onSettingsOpen: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

export default function IconRail({
  activeTab,
  onTabChange,
  hasUserRootfs,
  csrfToken,
  onSettingsOpen,
  darkMode,
  onToggleDarkMode,
}: IconRailProps) {
  return (
    <div className="flex w-12 flex-col items-center gap-0.5 border-r border-border bg-card py-3">
      <NavButton active={activeTab === "chat"} title="Chat" onClick={() => onTabChange("chat")}>
        <MessageSquare className="h-4 w-4" />
      </NavButton>
      <NavButton active={activeTab === "terminal"} title="Terminal" onClick={() => onTabChange("terminal")}>
        <Terminal className="h-4 w-4" />
      </NavButton>
      <NavButton active={activeTab === "files"} title="Files" onClick={() => onTabChange("files")}>
        <FolderOpen className="h-4 w-4" />
      </NavButton>

      <div className="mt-auto flex flex-col items-center gap-0.5">
        {hasUserRootfs && <ResetButton csrfToken={csrfToken} />}
        <NavButton
          title={darkMode ? "Light mode" : "Dark mode"}
          onClick={onToggleDarkMode}
        >
          {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </NavButton>
        <NavButton title="Settings" onClick={onSettingsOpen}>
          <Settings className="h-4 w-4" />
        </NavButton>
        <NavButton title="Sign out" onClick={() => { window.location.href = "/logout"; }}>
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
      className={`relative flex h-9 w-9 items-center justify-center rounded-lg ${
        active
          ? "bg-primary/15 text-primary shadow-sm ring-1 ring-primary/20"
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

function ResetButton({ csrfToken }: { csrfToken: string }) {
  const [open, setOpen] = React.useState(false);

  const handleReset = React.useCallback(async () => {
    const res = await fetch("/rootfs/delete", {
      method: "POST",
      headers: { "x-csrf-token": csrfToken },
    });
    if (res.ok || res.status === 303) {
      window.location.href = "/";
    }
  }, [csrfToken]);

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
            className="mx-4 w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-base font-semibold text-foreground">Reset Environment?</h3>
            <p className="mb-1 text-sm text-muted-foreground">
              This will permanently delete all your files and reset your workspace to a clean state.
            </p>
            <p className="mb-6 text-sm font-medium text-destructive">
              Please back up your files before proceeding. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90"
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
