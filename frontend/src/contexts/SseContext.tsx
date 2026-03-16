import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type {
  Conversation,
  FileEntry,
  SseEvent,
  StoredQuestion,
  TranscriptMessage,
} from "../types";
import { attachEventSourceListeners, readFetchSseStream } from "../utils/sse";
import { useConversations } from "../hooks/useConversations";
import { useQuestionStorage } from "../hooks/useQuestionStorage";

interface SseContextValue {
  vmId: string;
  csrfToken: string;
  uploadDir: string;
  uploadAction: string;
  hasUserRootfs: boolean;
  eventQueueRef: React.MutableRefObject<SseEvent[]>;
  eventSeq: number;
  conversations: Conversation[];
  createConversation: () => Conversation;
  updateConversation: (id: string, update: Partial<Conversation>) => void;
  deleteConversation: (id: string) => void;
  syncConversationsFromHistory: () => Promise<void>;
  sendQuery: (content: string, conversationId: string, sessionId?: string, workDir?: string) => void;
  sendStop: (taskId: string) => Promise<void>;
  answerQuestion: (taskId: string, requestId: string, answers: Record<string, string>) => Promise<void>;
  loadHistory: () => Promise<import("../types").ChatSession[]>;
  loadTranscript: (sessionId: string, projectDir: string, signal?: AbortSignal) => Promise<TranscriptMessage[]>;
  deleteSession: (sessionId: string, projectDir: string) => Promise<void>;
  listFiles: (path: string) => Promise<FileEntry[]>;
  storeQuestion: (requestId: string, data: StoredQuestion) => void;
  clearQuestion: (requestId: string) => void;
  getQuestionsForConversation: (conversationId: string) => StoredQuestion | null;
}

const SseContext = createContext<SseContextValue | null>(null);

function readAppConfig(): {
  vmId: string;
  csrfToken: string;
  uploadDir: string;
  uploadAction: string;
  hasUserRootfs: boolean;
} {
  const el = document.getElementById("app-config");
  return {
    vmId: el?.dataset.vmId ?? "",
    csrfToken: el?.dataset.csrfToken ?? "",
    uploadDir: el?.dataset.uploadDir ?? "/tmp",
    uploadAction: el?.dataset.uploadAction ?? "",
    hasUserRootfs: el?.dataset.hasUserRootfs === "true",
  };
}

export function SseProvider({ children }: { children: React.ReactNode }) {
  const config = useRef(readAppConfig());
  const { vmId, uploadDir, uploadAction, hasUserRootfs } = config.current;

  const csrfTokenRef = useRef(config.current.csrfToken);
  const [csrfToken, setCsrfToken] = useState(config.current.csrfToken);

  const refreshCsrfToken = useCallback((res: Response) => {
    const newToken = res.headers.get("x-csrf-token");
    if (newToken) {
      csrfTokenRef.current = newToken;
      setCsrfToken(newToken);
    }
  }, []);

  const eventQueueRef = useRef<SseEvent[]>([]);
  const [eventSeq, setEventSeq] = useState(0);

  const pushEvent = useCallback((event: SseEvent) => {
    eventQueueRef.current.push(event);
    setEventSeq((s) => s + 1);
  }, []);

  const loadHistory = useCallback(async (): Promise<import("../types").ChatSession[]> => {
    const res = await fetch("/chat-history");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, []);

  const {
    conversations,
    createConversation,
    updateConversation,
    deleteConversation,
    syncConversationsFromHistory,
  } = useConversations(vmId, loadHistory);

  const { storeQuestion, clearQuestion, getQuestionsForConversation } = useQuestionStorage();

  const esRef = useRef<EventSource | null>(null);

  // On mount: check for in-progress task and open reconnect stream
  useEffect(() => {
    const storageKey = `chat_running_task_${vmId}`;
    const saved = localStorage.getItem(storageKey);
    if (!saved) return;

    let parsed: { task_id?: string; running_session_id?: string | null };
    try {
      parsed = JSON.parse(saved) as { task_id?: string; running_session_id?: string | null };
    } catch {
      localStorage.removeItem(storageKey);
      return;
    }

    if (!parsed.task_id) {
      localStorage.removeItem(storageKey);
      return;
    }

    const taskId = parsed.task_id;
    const conversationId = parsed.running_session_id ?? taskId;

    pushEvent({
      type: "reconnecting",
      payload: { task_id: taskId, conversation_id: conversationId },
    });

    const url = `/chat-stream/${encodeURIComponent(taskId)}?conversation_id=${encodeURIComponent(conversationId)}`;
    const es = new EventSource(url);
    esRef.current = es;
    attachEventSourceListeners(es, pushEvent, vmId);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [vmId, pushEvent]);

  const sendQuery = useCallback((
    content: string,
    conversationId: string,
    sessionId?: string,
    workDir?: string,
  ) => {
    const executeStream = async () => {
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfTokenRef.current },
        body: JSON.stringify({
          conversation_id: conversationId,
          content,
          session_id: sessionId ?? null,
          work_dir: workDir ?? null,
        }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
      }
      refreshCsrfToken(res);
      await readFetchSseStream(res, pushEvent, vmId);
    };
    executeStream().catch((err: unknown) => {
      pushEvent({ type: "error_event", payload: { message: String(err) } });
    });
  }, [vmId, pushEvent, refreshCsrfToken]);

  const post = useCallback(async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": csrfTokenRef.current },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || `HTTP ${res.status}`);
    }
    refreshCsrfToken(res);
  }, [refreshCsrfToken]);

  const sendStop = useCallback(async (taskId: string) => {
    await post("/chat-stop", { task_id: taskId });
  }, [post]);

  const answerQuestion = useCallback(async (taskId: string, requestId: string, answers: Record<string, string>) => {
    await post("/chat-question-answer", { task_id: taskId, request_id: requestId, answers });
  }, [post]);

  const loadTranscript = useCallback(async (
    sessionId: string,
    projectDir: string,
    signal?: AbortSignal,
  ): Promise<TranscriptMessage[]> => {
    const params = new URLSearchParams({ session_id: sessionId, project_dir: projectDir });
    const res = await fetch(`/chat-transcript?${params}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.messages as TranscriptMessage[];
  }, []);

  const deleteSession = useCallback(async (sessionId: string, projectDir: string) => {
    const res = await fetch("/chat-transcript", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-csrf-token": csrfTokenRef.current },
      body: JSON.stringify({ session_id: sessionId, project_dir: projectDir }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    refreshCsrfToken(res);
  }, [refreshCsrfToken]);

  const listFiles = useCallback(async (path: string): Promise<FileEntry[]> => {
    const res = await fetch(`/ls?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.entries as FileEntry[];
  }, []);

  return (
    <SseContext.Provider value={{
      vmId,
      csrfToken,
      uploadDir,
      uploadAction,
      hasUserRootfs,
      eventQueueRef,
      eventSeq,
      conversations,
      createConversation,
      updateConversation,
      deleteConversation,
      syncConversationsFromHistory,
      sendQuery,
      sendStop,
      answerQuestion,
      loadHistory,
      loadTranscript,
      deleteSession,
      listFiles,
      storeQuestion,
      clearQuestion,
      getQuestionsForConversation,
    }}>
      {children}
    </SseContext.Provider>
  );
}

export function useSse(): SseContextValue {
  const ctx = useContext(SseContext);
  if (!ctx) throw new Error("useSse must be used inside SseProvider");
  return ctx;
}
