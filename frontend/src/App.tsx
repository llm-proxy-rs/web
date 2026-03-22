import React, { useCallback, useState } from "react";
import { SseProvider, useSse } from "./contexts/SseContext";
import IconRail from "./components/IconRail";
import Sidebar from "./components/Sidebar";
import ChatInterface from "./components/ChatInterface";
import Terminal from "./components/Terminal";
import FileManager from "./components/FileManager";
import MobileNav from "./components/MobileNav";
import SettingsPanel from "./components/SettingsPanel";
import { useUiPreferences } from "./hooks/useUiPreferences";
import type { Conversation, ViewTab } from "./types";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
          <div className="max-w-md space-y-2 p-6 text-center">
            <p className="text-base font-medium">Something went wrong</p>
            <p className="font-mono text-sm text-muted-foreground">
              {this.state.error.message}
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const {
    vmReady,
    hasUserRootfs,
    csrfFetch,
    conversations,
    createConversation,
    deleteConversation,
    deleteSession,
    syncConversationsFromHistory,
  } = useSse();
  const [activeTab, setActiveTab] = useState<ViewTab>("chat");
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null);
  const [runningConversationIds, setRunningConversationIds] = useState<
    Set<string>
  >(new Set());
  const [newChatKey, setNewChatKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const { preferences, setPreference } = useUiPreferences();
  const [showFilesPanel, setShowFilesPanel] = useState(false);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem("ui-theme");
    return saved ? saved === "dark" : true;
  });

  React.useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.remove("light");
    } else {
      document.documentElement.classList.add("light");
    }
    localStorage.setItem("ui-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const toggleDarkMode = useCallback(() => setDarkMode((m) => !m), []);

  const handleNewChat = useCallback(() => {
    setSelectedConversation(null);
    setNewChatKey((k) => k + 1);
  }, []);

  const handleDeleteConversation = useCallback(
    async (conversation: Conversation) => {
      try {
        if (conversation.sessionId && conversation.projectDir) {
          await deleteSession(conversation.sessionId, conversation.projectDir);
        }
      } catch (err) {
        console.error("Failed to delete session from server", err);
        return;
      }
      deleteConversation(conversation.conversationId);
      if (
        selectedConversation?.conversationId === conversation.conversationId
      ) {
        setSelectedConversation(null);
      }
    },
    [deleteSession, deleteConversation, selectedConversation],
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <IconRail
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasUserRootfs={hasUserRootfs}
        csrfFetch={csrfFetch}
        onSettingsOpen={() => setShowSettings(true)}
        onFilesOpen={() => setShowFilesPanel(true)}
        darkMode={darkMode}
        onToggleDarkMode={toggleDarkMode}
      />

      {!vmReady ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <svg
              className="h-6 w-6 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm">Starting environment…</span>
          </div>
        </div>
      ) : (
        <>
          {activeTab === "chat" && (
            <Sidebar
              conversations={conversations}
              viewConversationId={selectedConversation?.conversationId ?? null}
              runningConversationIds={runningConversationIds}
              onSelectConversation={(conv) => {
                setSelectedConversation(conv);
                setShowMobileSidebar(false);
              }}
              onNewChat={handleNewChat}
              onDeleteConversation={handleDeleteConversation}
              onRefresh={() => {
                syncConversationsFromHistory().catch(console.error);
              }}
              mobileOpen={showMobileSidebar}
              onMobileClose={() => setShowMobileSidebar(false)}
            />
          )}

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden pb-14 md:pb-0">
            {activeTab === "chat" && (
              <ChatInterface
                selectedConversation={selectedConversation}
                newChatKey={newChatKey}
                onRunningConversationChange={setRunningConversationIds}
                onConversationCreated={setSelectedConversation}
                preferences={preferences}
              />
            )}
            <div
              style={{ display: activeTab === "terminal" ? "flex" : "none" }}
              className="min-h-0 flex-1"
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <Terminal visible={activeTab === "terminal"} />
              </div>
            </div>
          </main>
        </>
      )}

      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          preferences={preferences}
          onTogglePreference={setPreference}
        />
      )}

      {showFilesPanel && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
          onClick={() => setShowFilesPanel(false)}
        >
          <div
            className="flex h-full w-full max-w-sm flex-col border-l border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <FileManager onClose={() => setShowFilesPanel(false)} />
          </div>
        </div>
      )}

      <MobileNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onToggleSidebar={() => setShowMobileSidebar((v) => !v)}
        onFilesOpen={() => setShowFilesPanel(true)}
      />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <SseProvider>
        <AppContent />
      </SseProvider>
    </ErrorBoundary>
  );
}
