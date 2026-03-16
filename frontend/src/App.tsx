import React, { useCallback, useState } from "react";
import { SseProvider, useSse } from "./contexts/SseContext";
import IconRail from "./components/IconRail";
import Sidebar from "./components/Sidebar";
import ChatInterface from "./components/ChatInterface";
import Terminal from "./components/Terminal";
import FileManager from "./components/FileManager";
import SettingsPanel from "./components/SettingsPanel";
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
            <p className="text-sm font-medium">Something went wrong</p>
            <p className="font-mono text-xs text-muted-foreground">{this.state.error.message}</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const { hasUserRootfs, csrfToken, conversations, createConversation, deleteConversation, deleteSession, syncConversationsFromHistory } = useSse();
  const [activeTab, setActiveTab] = useState<ViewTab>("chat");
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [runningConversationId, setRunningConversationId] = useState<string | null>(null);
  const [newChatKey, setNewChatKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
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

  const handleDeleteConversation = useCallback(async (conversation: Conversation) => {
    try {
      if (conversation.sessionId && conversation.projectDir) {
        await deleteSession(conversation.sessionId, conversation.projectDir);
      }
    } catch (err) {
      console.error("Failed to delete session from server", err);
      return;
    }
    deleteConversation(conversation.conversationId);
    if (selectedConversation?.conversationId === conversation.conversationId) {
      setSelectedConversation(null);
    }
  }, [deleteSession, deleteConversation, selectedConversation]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <IconRail
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasUserRootfs={hasUserRootfs}
        csrfToken={csrfToken}
        onSettingsOpen={() => setShowSettings(true)}
        darkMode={darkMode}
        onToggleDarkMode={toggleDarkMode}
      />

      {activeTab === "chat" && (
        <Sidebar
          conversations={conversations}
          viewConversationId={selectedConversation?.conversationId ?? null}
          runningConversationId={runningConversationId}
          onSelectConversation={setSelectedConversation}
          onNewChat={handleNewChat}
          onDeleteConversation={handleDeleteConversation}
          onRefresh={() => { syncConversationsFromHistory().catch(console.error); }}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {activeTab === "chat" && (
          <ChatInterface
            selectedConversation={selectedConversation}
            newChatKey={newChatKey}
            onRunningConversationChange={setRunningConversationId}
            onConversationCreated={setSelectedConversation}
          />
        )}
        <div
          style={{ display: activeTab === "terminal" ? "flex" : "none" }}
          className="min-h-0 flex-1 flex-col"
        >
          <Terminal visible={activeTab === "terminal"} />
        </div>
        <div
          style={{ display: activeTab === "files" ? "flex" : "none" }}
          className="min-h-0 flex-1 flex-col"
        >
          <FileManager />
        </div>
      </main>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
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
