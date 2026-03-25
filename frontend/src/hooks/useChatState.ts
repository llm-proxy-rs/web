import React, { useCallback, useRef, useState } from "react";
import type { ChatMessage, PendingQuestion, StreamPhaseInfo } from "../types";

function generateId(): string {
  return crypto.randomUUID();
}

export interface ChatStateResult {
  messagesBySession: React.MutableRefObject<Map<string, ChatMessage[]>>;
  viewConversationId: string | null;
  setViewConversationId: (id: string | null) => void;
  runningConversationIds: Set<string>;
  addRunningConversation: (id: string) => void;
  removeRunningConversation: (id: string) => void;
  isConversationRunning: (id: string) => boolean;
  touchConversation: (id: string) => void;
  lastActivityByConversation: React.MutableRefObject<Map<string, number>>;
  getSessionPendingQuestion: (
    conversationId: string | null,
  ) => PendingQuestion | null;
  setSessionPendingQuestion: (
    conversationId: string | null,
    q: PendingQuestion | null,
  ) => void;
  getTaskId: (conversationId: string | null) => string | undefined;
  setTaskId: (conversationId: string | null, clientId: string) => void;
  getStreamPhase: (conversationId: string | null) => StreamPhaseInfo;
  setStreamPhase: (
    conversationId: string | null,
    info: StreamPhaseInfo,
  ) => void;
  getMessages: (conversationId: string | null) => ChatMessage[];
  setMessages: (conversationId: string | null, msgs: ChatMessage[]) => void;
  addMessage: (conversationId: string | null, msg: ChatMessage) => void;
  removeMessage: (conversationId: string | null, id: string) => void;
  updateLastMessage: (
    conversationId: string | null,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  updateMessageById: (
    conversationId: string | null,
    id: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  getQueue: (conversationId: string | null) => string[];
  addToQueue: (conversationId: string | null, text: string) => void;
  removeFromQueue: (conversationId: string | null, index: number) => void;
  clearQueue: (conversationId: string | null) => void;
  shiftQueue: (conversationId: string | null) => string | undefined;
  generateId: () => string;
  renderTick: number;
  bumpRender: () => void;
}

export function useChatState(): ChatStateResult {
  const messagesBySession = useRef<Map<string, ChatMessage[]>>(new Map());
  const pendingQuestionsBySession = useRef<Map<string, PendingQuestion>>(
    new Map(),
  );
  const taskIdBySession = useRef<Map<string, string>>(new Map());
  const streamPhaseBySession = useRef<Map<string, StreamPhaseInfo>>(new Map());
  const queueBySession = useRef<Map<string, string[]>>(new Map());
  const lastActivityByConversation = useRef<Map<string, number>>(new Map());
  const [viewConversationId, setViewConversationId] = useState<string | null>(
    null,
  );
  const runningConversationIdsRef = useRef<Set<string>>(new Set());
  const [runningConversationIds, setRunningConversationIds] = useState<
    Set<string>
  >(new Set());
  const [renderTick, setRenderTick] = useState(0);

  const bumpRender = useCallback(() => setRenderTick((t) => t + 1), []);

  const addRunningConversation = useCallback((id: string) => {
    const wasRunning = runningConversationIdsRef.current.has(id);
    runningConversationIdsRef.current.add(id);
    lastActivityByConversation.current.set(id, Date.now());
    if (wasRunning) {
      console.warn(`[queue] addRunning conv=${id} ALREADY RUNNING`);
    } else {
      console.debug(`[queue] addRunning conv=${id}`);
    }
    setRunningConversationIds(new Set(runningConversationIdsRef.current));
  }, []);

  const removeRunningConversation = useCallback((id: string) => {
    const wasRunning = runningConversationIdsRef.current.has(id);
    runningConversationIdsRef.current.delete(id);
    lastActivityByConversation.current.delete(id);
    if (!wasRunning) {
      console.warn(`[queue] removeRunning conv=${id} WAS NOT RUNNING`);
    } else {
      console.debug(`[queue] removeRunning conv=${id}`);
    }
    setRunningConversationIds(new Set(runningConversationIdsRef.current));
  }, []);

  const isConversationRunning = useCallback((id: string): boolean => {
    return runningConversationIdsRef.current.has(id);
  }, []);

  const touchConversation = useCallback((id: string) => {
    lastActivityByConversation.current.set(id, Date.now());
  }, []);

  const getTaskId = useCallback(
    (conversationId: string | null): string | undefined => {
      if (conversationId === null) return undefined;
      return taskIdBySession.current.get(conversationId);
    },
    [],
  );

  const setTaskId = useCallback(
    (conversationId: string | null, clientId: string) => {
      if (conversationId === null) return;
      taskIdBySession.current.set(conversationId, clientId);
    },
    [],
  );

  const getStreamPhase = useCallback(
    (conversationId: string | null): StreamPhaseInfo => {
      if (conversationId === null) return { phase: "idle" };
      return (
        streamPhaseBySession.current.get(conversationId) ?? { phase: "idle" }
      );
    },
    [],
  );

  const setStreamPhase = useCallback(
    (conversationId: string | null, info: StreamPhaseInfo) => {
      if (conversationId === null) return;
      streamPhaseBySession.current.set(conversationId, info);
      setRenderTick((t) => t + 1);
    },
    [],
  );

  const getSessionPendingQuestion = useCallback(
    (conversationId: string | null): PendingQuestion | null => {
      if (conversationId === null) return null;
      return pendingQuestionsBySession.current.get(conversationId) ?? null;
    },
    [],
  );

  const setSessionPendingQuestion = useCallback(
    (conversationId: string | null, q: PendingQuestion | null) => {
      if (conversationId === null) return;
      if (q === null) {
        pendingQuestionsBySession.current.delete(conversationId);
      } else {
        pendingQuestionsBySession.current.set(conversationId, q);
      }
      setRenderTick((t) => t + 1);
    },
    [],
  );

  const getMessages = useCallback(
    (conversationId: string | null): ChatMessage[] => {
      if (conversationId === null) return [];
      return messagesBySession.current.get(conversationId) ?? [];
    },
    [],
  );

  const setMessages = useCallback(
    (conversationId: string | null, msgs: ChatMessage[]) => {
      if (conversationId === null) return;
      messagesBySession.current.set(conversationId, msgs);
      setRenderTick((t) => t + 1);
    },
    [],
  );

  const addMessage = useCallback(
    (conversationId: string | null, msg: ChatMessage) => {
      if (conversationId === null) return;
      const prev = messagesBySession.current.get(conversationId) ?? [];
      messagesBySession.current.set(conversationId, [...prev, msg]);
      setRenderTick((t) => t + 1);
    },
    [],
  );

  const removeMessage = useCallback(
    (conversationId: string | null, id: string) => {
      if (conversationId === null) return;
      const prev = messagesBySession.current.get(conversationId) ?? [];
      messagesBySession.current.set(
        conversationId,
        prev.filter((m) => m.id !== id),
      );
      setRenderTick((t) => t + 1);
    },
    [],
  );

  const updateLastMessage = useCallback(
    (
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
    },
    [],
  );

  const updateMessageById = useCallback(
    (
      conversationId: string | null,
      id: string,
      updater: (msg: ChatMessage) => ChatMessage,
    ) => {
      if (conversationId === null) return;
      const msgs = messagesBySession.current.get(conversationId) ?? [];
      const updated = msgs.map((m) => (m.id === id ? updater(m) : m));
      messagesBySession.current.set(conversationId, updated);
      setRenderTick((t) => t + 1);
    },
    [],
  );

  const getQueue = useCallback((conversationId: string | null): string[] => {
    if (conversationId === null) return [];
    return queueBySession.current.get(conversationId) ?? [];
  }, []);

  const addToQueue = useCallback(
    (conversationId: string | null, text: string) => {
      if (conversationId === null) return;
      const prev = queueBySession.current.get(conversationId) ?? [];
      queueBySession.current.set(conversationId, [...prev, text]);
      setRenderTick((t) => t + 1);
    },
    [],
  );

  const removeFromQueue = useCallback(
    (conversationId: string | null, index: number) => {
      if (conversationId === null) return;
      const prev = queueBySession.current.get(conversationId) ?? [];
      queueBySession.current.set(
        conversationId,
        prev.filter((_, i) => i !== index),
      );
      setRenderTick((t) => t + 1);
    },
    [],
  );

  const clearQueue = useCallback((conversationId: string | null) => {
    if (conversationId === null) return;
    queueBySession.current.delete(conversationId);
    setRenderTick((t) => t + 1);
  }, []);

  const shiftQueue = useCallback(
    (conversationId: string | null): string | undefined => {
      if (conversationId === null) return undefined;
      const prev = queueBySession.current.get(conversationId) ?? [];
      if (prev.length === 0) return undefined;
      const [first, ...rest] = prev;
      if (rest.length === 0) {
        queueBySession.current.delete(conversationId);
      } else {
        queueBySession.current.set(conversationId, rest);
      }
      setRenderTick((t) => t + 1);
      return first;
    },
    [],
  );

  return {
    messagesBySession,
    viewConversationId,
    setViewConversationId,
    runningConversationIds,
    addRunningConversation,
    removeRunningConversation,
    isConversationRunning,
    touchConversation,
    lastActivityByConversation,
    getSessionPendingQuestion,
    setSessionPendingQuestion,
    getTaskId,
    setTaskId,
    getStreamPhase,
    setStreamPhase,
    getMessages,
    setMessages,
    addMessage,
    removeMessage,
    updateLastMessage,
    updateMessageById,
    getQueue,
    addToQueue,
    removeFromQueue,
    clearQueue,
    shiftQueue,
    generateId,
    renderTick,
    bumpRender,
  };
}
