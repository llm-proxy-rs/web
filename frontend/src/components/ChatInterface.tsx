import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, Conversation } from "../types";
import type { UiPreferences } from "../hooks/useUiPreferences";
import { safeJsonParse } from "../utils/safeJson";
import { useSse } from "../contexts/SseContext";
import { useChatState } from "../hooks/useChatState";
import { useSseHandlers } from "../hooks/useSseHandlers";
import { buildMessagesFromTranscript } from "../utils/transcript";
import AskUserQuestionPanel from "./AskUserQuestionPanel";
import ChatComposer from "./ChatComposer";
import ChatMessagesPane from "./ChatMessagesPane";
import ClaudeStatus from "./ClaudeStatus";
import QueueDrawer from "./QueueDrawer";

interface ChatInterfaceProps {
  selectedConversation: Conversation | null;
  newChatKey?: number;
  onRunningConversationChange?: (runningIds: Set<string>) => void;
  onConversationCreated?: (conversation: Conversation) => void;
  preferences?: UiPreferences;
}

export default function ChatInterface({
  selectedConversation,
  newChatKey = 0,
  onRunningConversationChange,
  onConversationCreated,
  preferences,
}: ChatInterfaceProps) {
  const sseCtx = useSse();
  const {
    conversations,
    loadTranscript,
    loadHistory,
    updateConversation,
    storeQuestion,
    clearQuestion,
    getQuestionsForConversation,
  } = sseCtx;
  const chatState = useChatState();

  const [composerFocusKey, setComposerFocusKey] = useState(0);

  const {
    viewConversationId,
    setViewConversationId,
    runningConversationIds,
    addRunningConversation,
    removeRunningConversation,
    isConversationRunning,
    getSessionPendingQuestion,
    setSessionPendingQuestion,
    getTaskId,
    getMessages,
    addMessage,
    setMessages,
    generateId,
    getQueue,
    addToQueue,
    removeFromQueue,
    clearQueue,
    shiftQueue,
    lastActivityByConversation,
  } = chatState;

  // Fire whenever the user clicks "New Chat" — even if selectedConversation was
  // already null (in which case the selectedConversation effect below would not
  // re-run, leaving viewConversationId stale and the composer unfocused).
  const newChatKeyMounted = useRef(false);
  useEffect(() => {
    if (!newChatKeyMounted.current) {
      newChatKeyMounted.current = true;
      return;
    }
    setViewConversationId(null);
    setComposerFocusKey((k) => k + 1);
  }, [newChatKey, setViewConversationId]);

  useSseHandlers(
    {
      eventQueueRef: sseCtx.eventQueueRef,
      eventSeq: sseCtx.eventSeq,
      loadHistory,
      loadTranscript,
      updateConversation,
      storeQuestion,
      clearQuestion,
      getQuestionsForConversation,
      conversations,
      vmId: sseCtx.vmId,
    },
    chatState,
  );

  const loadTranscriptForConversation = useCallback(
    async (conversation: Conversation, signal?: AbortSignal) => {
      if (getMessages(conversation.conversationId).length > 0) return;

      // If sessionId + projectDir exist, try server transcript first
      if (conversation.sessionId && conversation.projectDir) {
        try {
          const transcript = await loadTranscript(
            conversation.sessionId,
            conversation.projectDir,
            signal,
          );
          const msgs = buildMessagesFromTranscript(transcript);
          if (msgs.length > 0) {
            setMessages(conversation.conversationId, msgs);
            // Update localStorage cache with fresh transcript
            localStorage.setItem(
              `chat_messages_${conversation.conversationId}`,
              JSON.stringify(msgs),
            );
            return;
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          console.error("Failed to load transcript", err);
        }
      }

      // Fall back to localStorage cache
      const cached = localStorage.getItem(
        `chat_messages_${conversation.conversationId}`,
      );
      if (cached) {
        try {
          const msgs = safeJsonParse<ChatMessage[]>(cached);
          if (msgs.length > 0) {
            setMessages(conversation.conversationId, msgs);
          }
        } catch {
          /* ignore parse errors */
        }
      }
    },
    [loadTranscript, getMessages, setMessages],
  );

  useEffect(() => {
    if (!selectedConversation) {
      setViewConversationId(null);
      setComposerFocusKey((k) => k + 1);
      return;
    }
    setViewConversationId(selectedConversation.conversationId);

    const abortController = new AbortController();
    loadTranscriptForConversation(selectedConversation, abortController.signal);

    // Restore any pending question for this conversation
    const storedQuestion = getQuestionsForConversation(
      selectedConversation.conversationId,
    );
    if (storedQuestion) {
      setSessionPendingQuestion(selectedConversation.conversationId, {
        requestId: storedQuestion.requestId,
        taskId: storedQuestion.taskId,
        questions: storedQuestion.questions,
      });
    }

    setComposerFocusKey((k) => k + 1);

    return () => abortController.abort();
  }, [
    selectedConversation,
    setViewConversationId,
    loadTranscriptForConversation,
    getQuestionsForConversation,
    setSessionPendingQuestion,
  ]);

  const onRunningConversationChangeRef = useRef(onRunningConversationChange);
  onRunningConversationChangeRef.current = onRunningConversationChange;
  useEffect(() => {
    onRunningConversationChangeRef.current?.(runningConversationIds);
  }, [runningConversationIds]);

  // Dispatch a message to a specific conversation (used by drain effect for queued messages)
  const dispatchMessageTo = useCallback(
    (targetConversationId: string, text: string) => {
      const conversation = conversations.find(
        (c) => c.conversationId === targetConversationId,
      );
      const sessionId = conversation?.sessionId;

      console.debug(
        `[queue] dispatchTo conv=${targetConversationId} session=${sessionId ?? "new"} text=${JSON.stringify(text.slice(0, 60))}`,
      );

      addMessage(targetConversationId, {
        id: generateId(),
        type: "user",
        content: text,
        timestamp: Date.now(),
      });
      addRunningConversation(targetConversationId);

      sseCtx.sendQuery(text, targetConversationId, sessionId);
    },
    [conversations, generateId, addMessage, addRunningConversation, sseCtx],
  );

  // Dispatch a message to the current view (creates a new conversation if needed)
  const dispatchMessage = useCallback(
    (text: string) => {
      let effectiveConversationId = viewConversationId;
      if (!effectiveConversationId) {
        const newConv = sseCtx.createConversation();
        effectiveConversationId = newConv.conversationId;
        setViewConversationId(effectiveConversationId);
        sseCtx.updateConversation(newConv.conversationId, {
          title: text.split("\n")[0].slice(0, 80).trim(),
        });
        onConversationCreated?.(newConv);
      }
      dispatchMessageTo(effectiveConversationId, text);
    },
    [
      viewConversationId,
      setViewConversationId,
      onConversationCreated,
      sseCtx,
      dispatchMessageTo,
    ],
  );

  // Drain refs — declared early so handleSend, handleAnswerQuestion, and
  // handleSkipQuestion can all reference them before the drain useEffect.
  const prevRunningIdsRef = useRef<Set<string>>(new Set());
  const drainingRef = useRef<Set<string>>(new Set());
  const pendingDrainRef = useRef<Set<string>>(new Set());

  const drainConversation = useCallback(
    (convId: string) => {
      if (drainingRef.current.has(convId)) return;
      const next = shiftQueue(convId);
      if (next !== undefined) {
        console.debug(
          `[queue] drain conv=${convId} text=${JSON.stringify(next.slice(0, 60))}`,
        );
        drainingRef.current.add(convId);
        Promise.resolve().then(() => {
          drainingRef.current.delete(convId);
          dispatchMessageTo(convId, next);
        });
      } else {
        console.debug(`[queue] conv=${convId} finished, queue empty`);
      }
    },
    [shiftQueue, dispatchMessageTo],
  );

  const handleSend = useCallback(
    (text: string) => {
      // If the current conversation is running or draining its queue, queue the message
      if (
        viewConversationId !== null &&
        (isConversationRunning(viewConversationId) ||
          drainingRef.current.has(viewConversationId))
      ) {
        console.debug(
          `[queue] enqueue conv=${viewConversationId} running=${isConversationRunning(viewConversationId)} draining=${drainingRef.current.has(viewConversationId)} text=${JSON.stringify(text.slice(0, 60))}`,
        );
        addToQueue(viewConversationId, text);
        return;
      }
      console.debug(
        `[queue] dispatch conv=${viewConversationId} text=${JSON.stringify(text.slice(0, 60))}`,
      );
      dispatchMessage(text);
    },
    [viewConversationId, isConversationRunning, dispatchMessage, addToQueue],
  );

  const handleStop = useCallback(() => {
    if (!viewConversationId) return;
    const taskId = getTaskId(viewConversationId);
    if (taskId) {
      sseCtx.sendStop(taskId).catch(console.error);
    } else {
      // Task ID not yet received — abort the in-flight fetch and clear running state
      sseCtx.abortQuery(viewConversationId);
      removeRunningConversation(viewConversationId);
    }
  }, [sseCtx, getTaskId, removeRunningConversation, viewConversationId]);

  const handleAnswerQuestion = useCallback(
    async (requestId: string, answers: Record<string, string>) => {
      const pending = getSessionPendingQuestion(viewConversationId);
      if (!pending) return;
      const taskId = pending.taskId;
      try {
        await sseCtx.answerQuestion(taskId, requestId, answers);
        setSessionPendingQuestion(viewConversationId, null);
        clearQuestion(requestId);
        // If the conversation finished while the question was pending, drain now
        if (
          viewConversationId &&
          !isConversationRunning(viewConversationId) &&
          pendingDrainRef.current.has(viewConversationId)
        ) {
          pendingDrainRef.current.delete(viewConversationId);
          drainConversation(viewConversationId);
        }
      } catch (err) {
        console.error(
          "Failed to send question answer, keeping question visible for retry",
          err,
        );
      }
    },
    [
      sseCtx,
      setSessionPendingQuestion,
      getSessionPendingQuestion,
      viewConversationId,
      clearQuestion,
      isConversationRunning,
      drainConversation,
    ],
  );

  const handleSkipQuestion = useCallback(
    async (requestId: string) => {
      const pending = getSessionPendingQuestion(viewConversationId);
      if (!pending) return;
      const taskId = pending.taskId;
      try {
        await sseCtx.answerQuestion(taskId, requestId, {});
        setSessionPendingQuestion(viewConversationId, null);
        clearQuestion(requestId);
        // If the conversation finished while the question was pending, drain now
        if (
          viewConversationId &&
          !isConversationRunning(viewConversationId) &&
          pendingDrainRef.current.has(viewConversationId)
        ) {
          pendingDrainRef.current.delete(viewConversationId);
          drainConversation(viewConversationId);
        }
      } catch (err) {
        console.error(
          "Failed to skip question, keeping question visible for retry",
          err,
        );
      }
    },
    [
      sseCtx,
      setSessionPendingQuestion,
      getSessionPendingQuestion,
      viewConversationId,
      clearQuestion,
      isConversationRunning,
      drainConversation,
    ],
  );

  const messages = getMessages(viewConversationId);
  const pendingQuestion = getSessionPendingQuestion(viewConversationId);
  const isCurrentRunning =
    viewConversationId !== null && isConversationRunning(viewConversationId);
  const streamPhase = chatState.getStreamPhase(viewConversationId);
  const messageQueue = getQueue(viewConversationId);

  // Drain queued messages when any conversation stops running.
  // Compares the current runningConversationIds with the previous snapshot
  // to find conversations that just finished, then dispatches their next queued message.
  // If a conversation has a pending question when it finishes, drain is deferred
  // until the question is answered (see handleAnswerQuestion / handleSkipQuestion).
  useEffect(() => {
    const prev = prevRunningIdsRef.current;
    prevRunningIdsRef.current = new Set(runningConversationIds);
    for (const convId of prev) {
      if (
        !runningConversationIds.has(convId) &&
        !drainingRef.current.has(convId)
      ) {
        if (getSessionPendingQuestion(convId)) {
          // Defer drain until the question is answered
          console.debug(
            `[queue] conv=${convId} finished with pending question, deferring drain`,
          );
          pendingDrainRef.current.add(convId);
        } else {
          drainConversation(convId);
        }
      }
    }
  }, [runningConversationIds, drainConversation, getSessionPendingQuestion]);

  // Staleness watchdog: if a running conversation hasn't received any SSE event
  // (including server heartbeats sent every 60s) for 90s, assume the connection
  // is dead and remove it from running so the queue can drain.
  useEffect(() => {
    if (runningConversationIds.size === 0) return;
    const STALE_MS = 90_000;
    const CHECK_MS = 15_000;
    const interval = setInterval(() => {
      const now = Date.now();
      for (const convId of runningConversationIds) {
        // Never mark a conversation stale while it has a pending question —
        // the agent is intentionally waiting for the user's answer.
        if (getSessionPendingQuestion(convId)) {
          lastActivityByConversation.current.set(convId, now);
          continue;
        }
        const lastActivity = lastActivityByConversation.current.get(convId);
        if (lastActivity !== undefined && now - lastActivity > STALE_MS) {
          console.warn(
            `Conversation ${convId} stale for ${STALE_MS}ms, marking idle`,
          );
          // Abort the dead in-flight fetch BEFORE removing from running.
          // This ensures the old connection is fully torn down before the
          // queue drain fires a replacement request, avoiding browser-level
          // NS_BINDING_ABORTED errors from rapid abort-then-reconnect.
          sseCtx.abortQuery(convId);
          removeRunningConversation(convId);
        }
      }
    }, CHECK_MS);
    return () => clearInterval(interval);
  }, [
    runningConversationIds,
    removeRunningConversation,
    lastActivityByConversation,
    getSessionPendingQuestion,
    sseCtx,
  ]);

  const handleRemoveQueued = useCallback(
    (index: number) => {
      removeFromQueue(viewConversationId, index);
    },
    [viewConversationId, removeFromQueue],
  );

  const handleClearQueue = useCallback(() => {
    clearQueue(viewConversationId);
  }, [viewConversationId, clearQueue]);

  // Drag-and-drop for the entire message area
  const [dragging, setDragging] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | undefined>();
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) setDroppedFiles(files);
  }, []);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-primary/5">
          <p className="text-sm font-medium text-primary">
            Drop files to attach
          </p>
        </div>
      )}
      <ChatMessagesPane
        key={viewConversationId ?? "empty"}
        messages={messages}
        isLoading={isCurrentRunning}
        autoScrollToBottom={preferences?.autoScrollToBottom}
        showThinking={preferences?.showThinking}
        autoExpandTools={preferences?.autoExpandTools}
      />
      <div className="mx-auto w-full max-w-3xl">
        <ClaudeStatus
          key={viewConversationId ?? "none"}
          isLoading={isCurrentRunning}
          streamPhase={streamPhase}
          onAbort={handleStop}
        />
      </div>
      {pendingQuestion ? (
        <div className="flex-shrink-0 border-t border-border p-4">
          <div className="mx-auto max-w-3xl">
            <AskUserQuestionPanel
              pendingQuestion={pendingQuestion}
              onSubmit={handleAnswerQuestion}
              onSkip={handleSkipQuestion}
            />
          </div>
        </div>
      ) : (
        <>
          <QueueDrawer
            messages={messageQueue}
            onRemove={handleRemoveQueued}
            onClear={handleClearQueue}
          />
          <ChatComposer
            isLoading={isCurrentRunning}
            onSend={handleSend}
            onStop={handleStop}
            focusKey={composerFocusKey}
            droppedFiles={droppedFiles}
            queuedCount={messageQueue.length}
          />
        </>
      )}
    </div>
  );
}
