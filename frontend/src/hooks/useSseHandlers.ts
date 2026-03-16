import { useEffect, useRef, type MutableRefObject } from "react";
import type { ChatMessage, ChatSession, Conversation, SseEvent, StoredQuestion, ToolMessage, TranscriptMessage } from "../types";
import type { ChatStateResult } from "./useChatState";
import { buildMessagesFromTranscript } from "../utils/transcript";

interface SseHandlerDeps {
  eventQueueRef: MutableRefObject<SseEvent[]>;
  eventSeq: number;
  loadHistory: () => Promise<ChatSession[]>;
  loadTranscript: (sessionId: string, projectDir: string, signal?: AbortSignal) => Promise<TranscriptMessage[]>;
  updateConversation: (id: string, update: Partial<Conversation>) => void;
  storeQuestion: (requestId: string, data: StoredQuestion) => void;
  clearQuestion: (requestId: string) => void;
  getQuestionsForConversation: (conversationId: string) => StoredQuestion | null;
  conversations: Conversation[];
  vmId: string;
}

interface PersistScheduler {
  schedule: (getMessages: () => ChatMessage[], taskId: string) => void;
  forceFlush: (getMessages: () => ChatMessage[], taskId: string) => void;
  cancel: () => void;
}

function createPersistScheduler(): PersistScheduler {
  let pendingId: number | null = null;
  let dirty = false;
  let pendingGetMessages: (() => ChatMessage[]) | null = null;
  let pendingTaskId: string | null = null;

  function writeToDisk() {
    if (!dirty || !pendingGetMessages || !pendingTaskId) return;
    dirty = false;
    const taskId = pendingTaskId;
    const messages = pendingGetMessages();
    localStorage.setItem(`chat_messages_task_${taskId}`, JSON.stringify(messages));
    pendingId = null;
  }

  function schedule(getMessages: () => ChatMessage[], taskId: string) {
    dirty = true;
    pendingGetMessages = getMessages;
    pendingTaskId = taskId;
    if (pendingId !== null) return;
    if (typeof requestIdleCallback === "function") {
      pendingId = requestIdleCallback(writeToDisk) as unknown as number;
    } else {
      pendingId = window.setTimeout(writeToDisk, 500);
    }
  }

  function forceFlush(getMessages: () => ChatMessage[], taskId: string) {
    if (pendingId !== null) {
      if (typeof cancelIdleCallback === "function") {
        cancelIdleCallback(pendingId);
      } else {
        clearTimeout(pendingId);
      }
      pendingId = null;
    }
    dirty = true;
    pendingGetMessages = getMessages;
    pendingTaskId = taskId;
    writeToDisk();
  }

  function cancel() {
    if (pendingId !== null) {
      if (typeof cancelIdleCallback === "function") {
        cancelIdleCallback(pendingId);
      } else {
        clearTimeout(pendingId);
      }
      pendingId = null;
    }
    dirty = false;
  }

  return { schedule, forceFlush, cancel };
}

export function useSseHandlers(
  sseState: SseHandlerDeps,
  chatState: ChatStateResult,
) {
  const {
    eventQueueRef,
    eventSeq,
    loadHistory,
    loadTranscript,
    updateConversation,
    storeQuestion,
    clearQuestion,
    getQuestionsForConversation,
    conversations,
    vmId,
  } = sseState;
  const {
    viewConversationId,
    runningConversationId,
    setRunningConversationId,
    setIsStreaming,
    setSessionPendingQuestion,
    setTaskId,
    addMessage,
    removeMessage,
    updateLastMessage,
    updateMessageById,
    getMessages,
    setMessages,
    setViewConversationId,
    generateId,
  } = chatState;

  const runningRef = useRef(runningConversationId);
  runningRef.current = runningConversationId;

  const viewRef = useRef(viewConversationId);
  viewRef.current = viewConversationId;

  const currentTaskIdRef = useRef<string | null>(null);
  const toolIdToMsgId = useRef<Map<string, string>>(new Map());
  const thinkingMsgId = useRef<string | null>(null);
  const assistantMsgId = useRef<string | null>(null);

  // Keep stable refs for conversations to avoid stale closures in the effect
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const schedulerRef = useRef<PersistScheduler>(createPersistScheduler());

  useEffect(() => {
    return () => schedulerRef.current.cancel();
  }, []);

  useEffect(() => {
    const events = eventQueueRef.current.splice(0);
    for (const event of events) {
      handleEvent(event);
    }

    function handleEvent(event: SseEvent) {
      const session = runningRef.current;

      const sealThinking = () => {
        if (!thinkingMsgId.current) return;
        const msgId = thinkingMsgId.current;
        thinkingMsgId.current = null;
        const msgs = getMessages(session);
        const thinkMsg = msgs.find((m) => m.id === msgId);
        if (thinkMsg && !thinkMsg.content) {
          removeMessage(session, msgId);
        }
      };

      switch (event.type) {
        case "task_created": {
          const { task_id, conversation_id } = event.payload;
          currentTaskIdRef.current = task_id;
          setTaskId(conversation_id, task_id);
          break;
        }

        case "session_start": {
          const { task_id } = event.payload;
          currentTaskIdRef.current = task_id;
          const conversationId = runningRef.current;
          setTaskId(conversationId, task_id);
          localStorage.setItem(
            `chat_running_task_${vmId}`,
            JSON.stringify({ task_id, running_session_id: conversationId }),
          );
          break;
        }

        case "init": {
          const id = generateId();
          thinkingMsgId.current = id;
          assistantMsgId.current = null;
          addMessage(session, {
            id,
            type: "assistant",
            content: "",
            timestamp: Date.now(),
            isThinking: true,
          });
          if (currentTaskIdRef.current) {
            const taskId = currentTaskIdRef.current;
            schedulerRef.current.schedule(() => getMessages(session), taskId);
          }
          break;
        }

        case "thinking_delta": {
          const { thinking } = event.payload;
          if (thinkingMsgId.current) {
            updateMessageById(session, thinkingMsgId.current, (m) => ({
              ...m,
              content: m.content + thinking,
            }));
            if (currentTaskIdRef.current) {
              const taskId = currentTaskIdRef.current;
              schedulerRef.current.schedule(() => getMessages(session), taskId);
            }
          }
          break;
        }

        case "text_delta": {
          const { text } = event.payload;
          sealThinking();
          if (!assistantMsgId.current) {
            const id = generateId();
            assistantMsgId.current = id;
            addMessage(session, {
              id,
              type: "assistant",
              content: text,
              timestamp: Date.now(),
            });
          } else {
            updateMessageById(session, assistantMsgId.current, (m) => ({
              ...m,
              content: m.content + text,
            }));
          }
          if (currentTaskIdRef.current) {
            const taskId = currentTaskIdRef.current;
            schedulerRef.current.schedule(() => getMessages(session), taskId);
          }
          break;
        }

        case "tool_start": {
          const { id: toolId, name, input } = event.payload;
          sealThinking();
          assistantMsgId.current = null;
          if (name === "AskUserQuestion") break;
          const msgId = generateId();
          toolIdToMsgId.current.set(toolId, msgId);
          addMessage(session, {
            id: msgId,
            type: "tool",
            content: "",
            timestamp: Date.now(),
            isToolUse: true,
            toolId,
            toolName: name,
            toolInput: input,
          });
          if (currentTaskIdRef.current) {
            const taskId = currentTaskIdRef.current;
            schedulerRef.current.schedule(() => getMessages(session), taskId);
          }
          break;
        }

        case "tool_result": {
          const { tool_use_id, content, is_error } = event.payload;
          const msgId = toolIdToMsgId.current.get(tool_use_id);
          if (msgId) {
            updateMessageById(session, msgId, (m) => {
              if (m.type !== "tool") return m;
              return { ...m, toolResult: { content, isError: is_error } };
            });
            if (currentTaskIdRef.current) {
              const taskId = currentTaskIdRef.current;
              schedulerRef.current.schedule(() => getMessages(session), taskId);
            }
          }
          break;
        }

        case "ask_user_question": {
          const { request_id, task_id, conversation_id, questions } = event.payload;
          sealThinking();
          assistantMsgId.current = null;
          setSessionPendingQuestion(conversation_id, { requestId: request_id, taskId: task_id, questions });
          storeQuestion(request_id, {
            conversationId: conversation_id,
            taskId: task_id,
            requestId: request_id,
            questions,
          });
          break;
        }

        case "done": {
          const { session_id, task_id, conversation_id } = event.payload;
          schedulerRef.current.forceFlush(() => getMessages(session), task_id);
          localStorage.removeItem(`chat_messages_task_${task_id}`);
          currentTaskIdRef.current = null;
          setRunningConversationId(null);
          setIsStreaming(false);
          setSessionPendingQuestion(conversation_id, null);
          sealThinking();
          assistantMsgId.current = null;
          toolIdToMsgId.current.clear();

          const storedQuestion = getQuestionsForConversation(conversation_id);
          if (storedQuestion) {
            clearQuestion(storedQuestion.requestId);
          }

          if (session_id) {
            updateConversation(conversation_id, { sessionId: session_id });
            loadHistory().then((sessions) => {
              const match = sessions.find((s) => s.session_id === session_id);
              if (match) {
                updateConversation(conversation_id, {
                  projectDir: match.project_dir,
                  title: match.title,
                });
              }
            }).catch(console.error);
          }
          break;
        }

        case "error_event": {
          const { message } = event.payload;
          if (currentTaskIdRef.current) {
            schedulerRef.current.forceFlush(() => getMessages(session), currentTaskIdRef.current);
            localStorage.removeItem(`chat_messages_task_${currentTaskIdRef.current}`);
            currentTaskIdRef.current = null;
          }
          setRunningConversationId(null);
          setIsStreaming(false);
          setSessionPendingQuestion(session, null);
          thinkingMsgId.current = null;
          assistantMsgId.current = null;
          toolIdToMsgId.current.clear();
          addMessage(session, {
            id: generateId(),
            type: "error",
            content: message,
            timestamp: Date.now(),
          });
          break;
        }

        case "reconnecting": {
          const { task_id, conversation_id } = event.payload;
          if (currentTaskIdRef.current === task_id) break;
          currentTaskIdRef.current = task_id;
          setTaskId(conversation_id, task_id);
          setRunningConversationId(conversation_id);
          setIsStreaming(true);
          setViewConversationId(conversation_id);

          let inProgressMessages: ChatMessage[] = [];
          const savedMessages = localStorage.getItem(`chat_messages_task_${task_id}`);
          if (savedMessages) {
            try {
              inProgressMessages = JSON.parse(savedMessages) as ChatMessage[];
              setMessages(conversation_id, inProgressMessages);
            } catch { /* ignore parse errors */ }
          }

          const conversation = conversationsRef.current.find((c) => c.conversationId === conversation_id);
          if (conversation?.sessionId && conversation?.projectDir) {
            loadTranscript(conversation.sessionId, conversation.projectDir).then((transcript) => {
              const historical = buildMessagesFromTranscript(transcript);
              if (historical.length > 0) {
                setMessages(conversation_id, [...historical, ...inProgressMessages]);
              }
            }).catch(console.error);
          }
          break;
        }
      }
    }
  }, [eventSeq]); // eslint-disable-line react-hooks/exhaustive-deps
}
