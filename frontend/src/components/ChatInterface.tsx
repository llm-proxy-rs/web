import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation } from "../types";
import { useSse } from "../contexts/SseContext";
import { useChatState } from "../hooks/useChatState";
import { useSseHandlers } from "../hooks/useSseHandlers";
import { buildMessagesFromTranscript } from "../utils/transcript";
import AskUserQuestionPanel from "./AskUserQuestionPanel";
import ChatComposer from "./ChatComposer";
import ChatMessagesPane from "./ChatMessagesPane";
import ClaudeStatus from "./ClaudeStatus";

interface ChatInterfaceProps {
  selectedConversation: Conversation | null;
  newChatKey?: number;
  onRunningConversationChange?: (conversationId: string | null) => void;
  onConversationCreated?: (conversation: Conversation) => void;
}

export default function ChatInterface({ selectedConversation, newChatKey = 0, onRunningConversationChange, onConversationCreated }: ChatInterfaceProps) {
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
    runningConversationId,
    setRunningConversationId,
    isStreaming,
    setIsStreaming,
    getSessionPendingQuestion,
    setSessionPendingQuestion,
    getTaskId,
    getMessages,
    addMessage,
    setMessages,
    generateId,
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

  const loadTranscriptForConversation = useCallback(async (conversation: Conversation, signal?: AbortSignal) => {
    if (!conversation.sessionId || !conversation.projectDir) return;
    if (getMessages(conversation.conversationId).length > 0) return;
    try {
      const transcript = await loadTranscript(conversation.sessionId, conversation.projectDir, signal);
      const msgs = buildMessagesFromTranscript(transcript);
      setMessages(conversation.conversationId, msgs);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("Failed to load transcript", err);
    }
  }, [loadTranscript, getMessages, setMessages]);

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
    const storedQuestion = getQuestionsForConversation(selectedConversation.conversationId);
    if (storedQuestion) {
      setSessionPendingQuestion(selectedConversation.conversationId, {
        requestId: storedQuestion.requestId,
        taskId: storedQuestion.taskId,
        questions: storedQuestion.questions,
      });
    }

    setComposerFocusKey((k) => k + 1);

    return () => abortController.abort();
  }, [selectedConversation, setViewConversationId, loadTranscriptForConversation, getQuestionsForConversation, setSessionPendingQuestion]);

  const onRunningConversationChangeRef = useRef(onRunningConversationChange);
  onRunningConversationChangeRef.current = onRunningConversationChange;
  useEffect(() => {
    onRunningConversationChangeRef.current?.(runningConversationId);
  }, [runningConversationId]);

  const handleSend = useCallback((text: string) => {
    let effectiveConversationId = viewConversationId;
    if (!effectiveConversationId) {
      const newConv = sseCtx.createConversation();
      effectiveConversationId = newConv.conversationId;
      setViewConversationId(effectiveConversationId);
      sseCtx.updateConversation(newConv.conversationId, { title: text.split("\n")[0].slice(0, 80).trim() });
      onConversationCreated?.(newConv);
    }

    const conversation = conversations.find((c) => c.conversationId === effectiveConversationId);
    const sessionId = conversation?.sessionId;

    addMessage(effectiveConversationId, {
      id: generateId(),
      type: "user",
      content: text,
      timestamp: Date.now(),
    });
    setRunningConversationId(effectiveConversationId);
    setIsStreaming(true);

    sseCtx.sendQuery(text, effectiveConversationId, sessionId);
  }, [viewConversationId, conversations, generateId, addMessage, setRunningConversationId, setIsStreaming, setViewConversationId, onConversationCreated, sseCtx]);

  const handleStop = useCallback(() => {
    sseCtx.sendStop(getTaskId(runningConversationId) ?? "").catch(console.error);
  }, [sseCtx, getTaskId, runningConversationId]);

  const handleAnswerQuestion = useCallback(
    async (requestId: string, answers: Record<string, string>) => {
      const taskId = getSessionPendingQuestion(viewConversationId)?.taskId ?? "";
      setSessionPendingQuestion(viewConversationId, null);
      clearQuestion(requestId);
      await sseCtx.answerQuestion(taskId, requestId, answers);
    },
    [sseCtx, setSessionPendingQuestion, getSessionPendingQuestion, viewConversationId, clearQuestion],
  );

  const handleSkipQuestion = useCallback(
    async (requestId: string) => {
      const taskId = getSessionPendingQuestion(viewConversationId)?.taskId ?? "";
      setSessionPendingQuestion(viewConversationId, null);
      clearQuestion(requestId);
      await sseCtx.answerQuestion(taskId, requestId, {});
    },
    [sseCtx, setSessionPendingQuestion, getSessionPendingQuestion, viewConversationId, clearQuestion],
  );

  const messages = getMessages(viewConversationId);
  const pendingQuestion = getSessionPendingQuestion(viewConversationId);
  const isCurrentRunning = isStreaming && runningConversationId === viewConversationId;
  const isOtherRunning = isStreaming && runningConversationId !== viewConversationId;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatMessagesPane messages={messages} isLoading={isCurrentRunning} />
      <ClaudeStatus isLoading={isCurrentRunning} onAbort={handleStop} />
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
        <ChatComposer
          isLoading={isCurrentRunning}
          isOtherRunning={isOtherRunning}
          onSend={handleSend}
          onStop={handleStop}
          focusKey={composerFocusKey}
        />
      )}
    </div>
  );
}
