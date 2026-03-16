import React, { useCallback, useRef, useState } from "react";
import type { ChatMessage, PendingQuestion } from "../types";

function generateId(): string {
  return crypto.randomUUID();
}

export interface ChatStateResult {
  messagesBySession: React.MutableRefObject<Map<string, ChatMessage[]>>;
  viewConversationId: string | null;
  setViewConversationId: (id: string | null) => void;
  runningConversationId: string | null;
  setRunningConversationId: (id: string | null) => void;
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
  getSessionPendingQuestion: (conversationId: string | null) => PendingQuestion | null;
  setSessionPendingQuestion: (conversationId: string | null, q: PendingQuestion | null) => void;
  getTaskId: (conversationId: string | null) => string | undefined;
  setTaskId: (conversationId: string | null, clientId: string) => void;
  getMessages: (conversationId: string | null) => ChatMessage[];
  setMessages: (conversationId: string | null, msgs: ChatMessage[]) => void;
  addMessage: (conversationId: string | null, msg: ChatMessage) => void;
  removeMessage: (conversationId: string | null, id: string) => void;
  updateLastMessage: (conversationId: string | null, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessageById: (conversationId: string | null, id: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  generateId: () => string;
  renderTick: number;
  bumpRender: () => void;
}

export function useChatState(): ChatStateResult {
  const messagesBySession = useRef<Map<string, ChatMessage[]>>(new Map());
  const pendingQuestionsBySession = useRef<Map<string, PendingQuestion>>(new Map());
  const taskIdBySession = useRef<Map<string, string>>(new Map());
  const [viewConversationId, setViewConversationId] = useState<string | null>(null);
  const [runningConversationId, setRunningConversationId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [renderTick, setRenderTick] = useState(0);

  const bumpRender = useCallback(() => setRenderTick((t) => t + 1), []);

  const getTaskId = useCallback((conversationId: string | null): string | undefined => {
    if (conversationId === null) return undefined;
    return taskIdBySession.current.get(conversationId);
  }, []);

  const setTaskId = useCallback((conversationId: string | null, clientId: string) => {
    if (conversationId === null) return;
    taskIdBySession.current.set(conversationId, clientId);
  }, []);

  const getSessionPendingQuestion = useCallback((conversationId: string | null): PendingQuestion | null => {
    if (conversationId === null) return null;
    return pendingQuestionsBySession.current.get(conversationId) ?? null;
  }, []);

  const setSessionPendingQuestion = useCallback((conversationId: string | null, q: PendingQuestion | null) => {
    if (conversationId === null) return;
    if (q === null) {
      pendingQuestionsBySession.current.delete(conversationId);
    } else {
      pendingQuestionsBySession.current.set(conversationId, q);
    }
    setRenderTick((t) => t + 1);
  }, []);

  const getMessages = useCallback((conversationId: string | null): ChatMessage[] => {
    if (conversationId === null) return [];
    return messagesBySession.current.get(conversationId) ?? [];
  }, []);

  const setMessages = useCallback((conversationId: string | null, msgs: ChatMessage[]) => {
    if (conversationId === null) return;
    messagesBySession.current.set(conversationId, msgs);
    setRenderTick((t) => t + 1);
  }, []);

  const addMessage = useCallback((conversationId: string | null, msg: ChatMessage) => {
    if (conversationId === null) return;
    const prev = messagesBySession.current.get(conversationId) ?? [];
    messagesBySession.current.set(conversationId, [...prev, msg]);
    setRenderTick((t) => t + 1);
  }, []);

  const removeMessage = useCallback((conversationId: string | null, id: string) => {
    if (conversationId === null) return;
    const prev = messagesBySession.current.get(conversationId) ?? [];
    messagesBySession.current.set(conversationId, prev.filter((m) => m.id !== id));
    setRenderTick((t) => t + 1);
  }, []);

  const updateLastMessage = useCallback((
    conversationId: string | null,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => {
    if (conversationId === null) return;
    const msgs = messagesBySession.current.get(conversationId) ?? [];
    if (msgs.length === 0) return;
    const updated = [...msgs];
    updated[updated.length - 1] = updater(updated[updated.length - 1]);
    messagesBySession.current.set(conversationId, updated);
    setRenderTick((t) => t + 1);
  }, []);

  const updateMessageById = useCallback((
    conversationId: string | null,
    id: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => {
    if (conversationId === null) return;
    const msgs = messagesBySession.current.get(conversationId) ?? [];
    const updated = msgs.map((m) => (m.id === id ? updater(m) : m));
    messagesBySession.current.set(conversationId, updated);
    setRenderTick((t) => t + 1);
  }, []);

  return {
    messagesBySession,
    viewConversationId,
    setViewConversationId,
    runningConversationId,
    setRunningConversationId,
    isStreaming,
    setIsStreaming,
    getSessionPendingQuestion,
    setSessionPendingQuestion,
    getTaskId,
    setTaskId,
    getMessages,
    setMessages,
    addMessage,
    removeMessage,
    updateLastMessage,
    updateMessageById,
    generateId,
    renderTick,
    bumpRender,
  };
}
