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

  const handleSend = useCallback(
    (text: string) => {
      // If the current conversation is running, queue the message
      if (
        viewConversationId !== null &&
        isConversationRunning(viewConversationId)
      ) {
        addToQueue(viewConversationId, text);
        return;
      }
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
      sseCtx.abortQuery();
      removeRunningConversation(viewConversationId);
    }
  }, [sseCtx, getTaskId, removeRunningConversation, viewConversationId]);

  const handleAnswerQuestion = useCallback(
    async (requestId: string, answers: Record<string, string>) => {
      const taskId =
        getSessionPendingQuestion(viewConversationId)?.taskId ?? "";
      setSessionPendingQuestion(viewConversationId, null);
      clearQuestion(requestId);
      await sseCtx.answerQuestion(taskId, requestId, answers);
    },
    [
      sseCtx,
      setSessionPendingQuestion,
      getSessionPendingQuestion,
      viewConversationId,
      clearQuestion,
    ],
  );

  const handleSkipQuestion = useCallback(
    async (requestId: string) => {
      const taskId =
        getSessionPendingQuestion(viewConversationId)?.taskId ?? "";
      setSessionPendingQuestion(viewConversationId, null);
      clearQuestion(requestId);
      await sseCtx.answerQuestion(taskId, requestId, {});
    },
    [
      sseCtx,
      setSessionPendingQuestion,
      getSessionPendingQuestion,
      viewConversationId,
      clearQuestion,
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
  const prevRunningIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevRunningIdsRef.current;
    prevRunningIdsRef.current = new Set(runningConversationIds);
    for (const convId of prev) {
      if (!runningConversationIds.has(convId)) {
        const next = shiftQueue(convId);
        if (next !== undefined) {
          setTimeout(() => dispatchMessageTo(convId, next), 100);
        }
      }
    }
  }, [runningConversationIds, shiftQueue, dispatchMessageTo]);

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
