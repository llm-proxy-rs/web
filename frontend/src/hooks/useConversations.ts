import { useCallback, useEffect, useState } from "react";
import type { ChatSession, Conversation } from "../types";
import { safeJsonParse } from "../utils/safeJson";

function loadConversationsFromStorage(vmId: string): Conversation[] {
  try {
    const saved = localStorage.getItem(`conversations_${vmId}`);
    return saved ? safeJsonParse<Conversation[]>(saved) : [];
  } catch {
    return [];
  }
}

function saveConversationsToStorage(
  vmId: string,
  conversations: Conversation[],
): void {
  localStorage.setItem(`conversations_${vmId}`, JSON.stringify(conversations));
}

export function useConversations(
  vmId: string,
  loadHistory: () => Promise<ChatSession[]>,
) {
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadConversationsFromStorage(vmId),
  );

  // Re-load from localStorage when vmId changes (e.g. empty -> real ID)
  useEffect(() => {
    if (!vmId) return;
    setConversations(loadConversationsFromStorage(vmId));
  }, [vmId]);

  const createConversation = useCallback((): Conversation => {
    const conversation: Conversation = {
      conversationId: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    setConversations((prev) => {
      const updated = [conversation, ...prev];
      saveConversationsToStorage(vmId, updated);
      return updated;
    });
    return conversation;
  }, [vmId]);

  const updateConversation = useCallback(
    (id: string, update: Partial<Conversation>) => {
      setConversations((prev) => {
        const updated = prev.map((c) =>
          c.conversationId === id ? { ...c, ...update } : c,
        );
        saveConversationsToStorage(vmId, updated);
        return updated;
      });
    },
    [vmId],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      localStorage.removeItem(`chat_messages_${id}`);
      setConversations((prev) => {
        const updated = prev.filter((c) => c.conversationId !== id);
        saveConversationsToStorage(vmId, updated);
        return updated;
      });
    },
    [vmId],
  );

  const syncConversationsFromHistory = useCallback(async () => {
    const sessions = await loadHistory();
    setConversations((prev) => {
      const existingSessionIds = new Set(
        prev.map((c) => c.sessionId).filter((id): id is string => !!id),
      );
      const newConversations: Conversation[] = sessions
        .filter((s) => !existingSessionIds.has(s.session_id))
        .map((s) => ({
          conversationId: crypto.randomUUID(),
          sessionId: s.session_id,
          projectDir: s.project_dir,
          title: s.title,
          createdAt: new Date(s.created_at).getTime(),
        }));
      if (newConversations.length === 0) return prev;
      const updated = [...prev, ...newConversations];
      saveConversationsToStorage(vmId, updated);
      return updated;
    });
  }, [loadHistory, vmId]);

  // Sync server sessions into local conversations whenever vmId becomes available
  useEffect(() => {
    if (!vmId) return;
    syncConversationsFromHistory().catch(console.error);
  }, [vmId, syncConversationsFromHistory]);

  return {
    conversations,
    createConversation,
    updateConversation,
    deleteConversation,
    syncConversationsFromHistory,
  };
}
