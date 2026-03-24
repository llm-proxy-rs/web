import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { safeJsonParse } from "../utils/safeJson";
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
  vmReady: boolean;
  /** Fetch wrapper that auto-attaches and rotates the CSRF token for mutating requests. */
  csrfFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
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
  sendQuery: (
    content: string,
    conversationId: string,
    sessionId?: string,
    workDir?: string,
  ) => void;
  abortQuery: () => void;
  sendStop: (taskId: string) => Promise<void>;
  answerQuestion: (
    taskId: string,
    requestId: string,
    answers: Record<string, string>,
  ) => Promise<void>;
  loadHistory: () => Promise<import("../types").ChatSession[]>;
  loadTranscript: (
    sessionId: string,
    projectDir: string,
    signal?: AbortSignal,
  ) => Promise<TranscriptMessage[]>;
  deleteSession: (sessionId: string, projectDir: string) => Promise<void>;
  listFiles: (path: string) => Promise<FileEntry[]>;
  storeQuestion: (requestId: string, data: StoredQuestion) => void;
  clearQuestion: (requestId: string) => void;
  getQuestionsForConversation: (
    conversationId: string,
  ) => StoredQuestion | null;
  /** Reset vmId to trigger re-provisioning via vm-status polling. */
  resetVmId: () => void;
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
  const { uploadDir, uploadAction, hasUserRootfs } = config.current;

  const [vmId, setVmId] = useState(config.current.vmId);
  const vmReady = vmId !== "";

  const csrfTokenRef = useRef(config.current.csrfToken);
  const [csrfToken, setCsrfToken] = useState(config.current.csrfToken);

  const refreshCsrfToken = useCallback((res: Response) => {
    const newToken = res.headers.get("x-csrf-token");
    if (newToken) {
      csrfTokenRef.current = newToken;
      setCsrfToken(newToken);
    }
  }, []);

  // Poll /api/vm-status until the VM is ready
  useEffect(() => {
    if (vmId !== "") return;
    let cancelled = false;
    const MAX_ATTEMPTS = 90; // ~3 minutes at 2s intervals
    const poll = async () => {
      let attempts = 0;
      while (!cancelled && attempts < MAX_ATTEMPTS) {
        attempts++;
        try {
          const res = await fetch("/api/vm-status");
          // If redirected to login page, navigate there
          if (res.redirected) {
            try {
              const redirectUrl = new URL(res.url);
              if (redirectUrl.origin !== window.location.origin) {
                window.location.href = "/";
                return;
              }
            } catch {
              window.location.href = "/";
              return;
            }
            window.location.href = res.url;
            return;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const contentType = res.headers.get("content-type") ?? "";
          if (!contentType.includes("application/json"))
            throw new Error("not JSON");
          const data = await res.json();
          if (data.status === "ready" && data.vm_id) {
            setVmId(data.vm_id);
            return;
          }
        } catch {
          // ignore, retry
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [vmId]);

  const csrfFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const existingHeaders = init?.headers;
      // Merge csrf token without using new Headers() — that would override
      // the browser's automatic Content-Type for FormData bodies.
      let merged: Record<string, string>;
      if (existingHeaders instanceof Headers) {
        merged = Object.fromEntries(existingHeaders.entries());
      } else if (Array.isArray(existingHeaders)) {
        merged = Object.fromEntries(existingHeaders);
      } else {
        merged = { ...(existingHeaders as Record<string, string> | undefined) };
      }
      if (!merged["x-csrf-token"]) {
        merged["x-csrf-token"] = csrfTokenRef.current;
      }
      const res = await fetch(input, { ...init, headers: merged });
      const newToken = res.headers.get("x-csrf-token");
      if (newToken) {
        csrfTokenRef.current = newToken;
        setCsrfToken(newToken);
      }
      return res;
    },
    [],
  );

  const eventQueueRef = useRef<SseEvent[]>([]);
  const [eventSeq, setEventSeq] = useState(0);

  const pushEvent = useCallback((event: SseEvent) => {
    eventQueueRef.current.push(event);
    setEventSeq((s) => s + 1);
  }, []);

  const loadHistory = useCallback(async (): Promise<
    import("../types").ChatSession[]
  > => {
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

  const { storeQuestion, clearQuestion, getQuestionsForConversation } =
    useQuestionStorage();

  const esRef = useRef<EventSource | null>(null);
  const queryAbortRef = useRef<AbortController | null>(null);

  // On mount: check for in-progress task and open reconnect stream
  useEffect(() => {
    const storageKey = `chat_running_task_${vmId}`;
    const saved = localStorage.getItem(storageKey);
    if (!saved) return;

    let parsed: { task_id?: string; running_session_id?: string | null };
    try {
      parsed = safeJsonParse<{
        task_id?: string;
        running_session_id?: string | null;
      }>(saved);
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

    const taggedPush = (event: SseEvent): void => {
      pushEvent({ ...event, conversationId } as SseEvent);
    };

    const url = `/chat-stream/${encodeURIComponent(taskId)}?conversation_id=${encodeURIComponent(conversationId)}`;
    const es = new EventSource(url);
    esRef.current = es;
    attachEventSourceListeners(es, taggedPush, vmId);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [vmId, pushEvent]);

  const sendQuery = useCallback(
    (
      content: string,
      conversationId: string,
      sessionId?: string,
      workDir?: string,
    ) => {
      const taggedPush = (event: SseEvent): void => {
        pushEvent({ ...event, conversationId } as SseEvent);
      };
      const abortController = new AbortController();
      queryAbortRef.current = abortController;
      const executeStream = async () => {
        const res = await csrfFetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversationId,
            content,
            session_id: sessionId ?? null,
            work_dir: workDir ?? null,
          }),
          signal: abortController.signal,
        });
        if (res.status === 503) {
          // VM is still starting — clean up running state silently so the user can retry.
          pushEvent({ type: "query_aborted", conversationId });
          return;
        }
        if (!res.ok) {
          const msg = await res.text();
          throw new Error(msg || `HTTP ${res.status}`);
        }
        await readFetchSseStream(res, taggedPush, vmId);
      };
      executeStream()
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          taggedPush({
            type: "error_event",
            payload: { message: String(err) },
          });
        })
        .finally(() => {
          if (queryAbortRef.current === abortController) {
            queryAbortRef.current = null;
          }
        });
    },
    [vmId, pushEvent, csrfFetch],
  );

  const abortQuery = useCallback(() => {
    queryAbortRef.current?.abort();
    queryAbortRef.current = null;
  }, []);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const res = await csrfFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
      }
    },
    [csrfFetch],
  );

  const sendStop = useCallback(
    async (taskId: string) => {
      await post("/chat-stop", { task_id: taskId });
    },
    [post],
  );

  const answerQuestion = useCallback(
    async (
      taskId: string,
      requestId: string,
      answers: Record<string, string>,
    ) => {
      await post("/chat-question-answer", {
        task_id: taskId,
        request_id: requestId,
        answers,
      });
    },
    [post],
  );

  const loadTranscript = useCallback(
    async (
      sessionId: string,
      projectDir: string,
      signal?: AbortSignal,
    ): Promise<TranscriptMessage[]> => {
      const params = new URLSearchParams({
        session_id: sessionId,
        project_dir: projectDir,
      });
      const res = await fetch(`/chat-transcript?${params}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.messages as TranscriptMessage[];
    },
    [],
  );

  const deleteSession = useCallback(
    async (sessionId: string, projectDir: string) => {
      const res = await csrfFetch("/chat-transcript", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          project_dir: projectDir,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    [csrfFetch],
  );

  const listFiles = useCallback(async (path: string): Promise<FileEntry[]> => {
    const res = await fetch(`/ls?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.entries as FileEntry[];
  }, []);

  const resetVmId = useCallback(() => {
    if (vmId) {
      localStorage.removeItem(`chat_running_task_${vmId}`);
    }
    setVmId("");
  }, [vmId]);

  return (
    <SseContext.Provider
      value={{
        vmId,
        vmReady,
        csrfFetch,
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
        abortQuery,
        sendStop,
        answerQuestion,
        loadHistory,
        loadTranscript,
        deleteSession,
        listFiles,
        storeQuestion,
        clearQuestion,
        getQuestionsForConversation,
        resetVmId,
      }}
    >
      {children}
    </SseContext.Provider>
  );
}

export function useSse(): SseContextValue {
  const ctx = useContext(SseContext);
  if (!ctx) throw new Error("useSse must be used inside SseProvider");
  return ctx;
}
