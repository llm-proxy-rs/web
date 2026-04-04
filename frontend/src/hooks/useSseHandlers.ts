import { useEffect, useRef, type MutableRefObject } from "react";
import { safeJsonParse } from "../utils/safeJson";
import type {
  ChatMessage,
  ChatSession,
  Conversation,
  SseEvent,
  StoredQuestion,
  ToolMessage,
  TranscriptMessage,
  AgentTask,
  TokenUsage,
} from "../types";
import type { ChatStateResult } from "./useChatState";
import { buildMessagesFromTranscript } from "../utils/transcript";
import { setRunningTask, removeRunningTask } from "../utils/runningTasks";

interface SseHandlerDeps {
  eventQueueRef: MutableRefObject<SseEvent[]>;
  eventSeq: number;
  loadHistory: () => Promise<ChatSession[]>;
  loadTranscript: (
    sessionId: string,
    projectDir: string,
    signal?: AbortSignal,
  ) => Promise<TranscriptMessage[]>;
  updateConversation: (id: string, update: Partial<Conversation>) => void;
  storeQuestion: (requestId: string, data: StoredQuestion) => void;
  clearQuestion: (requestId: string) => void;
  getQuestionsForConversation: (
    conversationId: string,
  ) => StoredQuestion | null;
  conversations: Conversation[];
  vmId: string;
}

interface PersistScheduler {
  schedule: (
    getMessages: () => ChatMessage[],
    taskId: string,
    conversationId?: string,
  ) => void;
  forceFlush: (
    getMessages: () => ChatMessage[],
    taskId: string,
    conversationId?: string,
  ) => void;
  cancel: () => void;
}

function createPersistScheduler(): PersistScheduler {
  let pendingId: number | null = null;
  let dirty = false;
  let pendingGetMessages: (() => ChatMessage[]) | null = null;
  let pendingTaskId: string | null = null;
  let pendingConversationId: string | null = null;

  function writeToDisk() {
    if (!dirty || !pendingGetMessages || !pendingTaskId) return;
    dirty = false;
    const taskId = pendingTaskId;
    const conversationId = pendingConversationId;
    const messages = pendingGetMessages();
    localStorage.setItem(
      `chat_messages_task_${taskId}`,
      JSON.stringify(messages),
    );
    if (conversationId && messages.length > 0) {
      localStorage.setItem(
        `chat_messages_${conversationId}`,
        JSON.stringify(messages),
      );
    }
    pendingId = null;
  }

  function schedule(
    getMessages: () => ChatMessage[],
    taskId: string,
    conversationId?: string,
  ) {
    dirty = true;
    pendingGetMessages = getMessages;
    pendingTaskId = taskId;
    if (conversationId) pendingConversationId = conversationId;
    if (pendingId !== null) return;
    if (typeof requestIdleCallback === "function") {
      pendingId = requestIdleCallback(writeToDisk) as unknown as number;
    } else {
      pendingId = window.setTimeout(writeToDisk, 500);
    }
  }

  function forceFlush(
    getMessages: () => ChatMessage[],
    taskId: string,
    conversationId?: string,
  ) {
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
    if (conversationId) pendingConversationId = conversationId;
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

interface StreamState {
  taskId: string | null;
  thinkingMsgId: string | null;
  thinkingStartedAt: number | null;
  assistantMsgId: string | null;
  toolIdToMsgId: Map<string, string>;
  toolIdToName: Map<string, string>;
  estimatedTokens: number;
}

function getOrCreateStreamState(
  map: Map<string, StreamState>,
  conversationId: string,
): StreamState {
  let state = map.get(conversationId);
  if (!state) {
    state = {
      taskId: null,
      thinkingMsgId: null,
      thinkingStartedAt: null,
      assistantMsgId: null,
      toolIdToMsgId: new Map(),
      toolIdToName: new Map(),
      estimatedTokens: 0,
    };
    map.set(conversationId, state);
  }
  return state;
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
    addRunningConversation,
    removeRunningConversation,
    setSessionPendingQuestion,
    setTaskId,
    addMessage,
    removeMessage,
    updateMessageById,
    getMessages,
    setMessages,
    setViewConversationId,
    setStreamPhase,
    generateId,
    touchConversation,
  } = chatState;

  const viewRef = useRef(viewConversationId);
  viewRef.current = viewConversationId;

  const streamStateRef = useRef<Map<string, StreamState>>(new Map());

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

    function resolveConversationId(event: SseEvent): string | null {
      // Tagged at source (sendQuery / reconnect wrapper)
      if ("conversationId" in event && event.conversationId) {
        return event.conversationId;
      }
      // Payload-level conversation_id for events that carry it
      if (event.type === "task_created") return event.payload.conversation_id;
      if (event.type === "done") return event.payload.conversation_id;
      if (event.type === "ask_user_question")
        return event.payload.conversation_id;
      if (event.type === "reconnecting") return event.payload.conversation_id;
      return null;
    }

    function handleEvent(event: SseEvent) {
      const conversationId = resolveConversationId(event);

      // Track activity for staleness detection
      if (conversationId) {
        touchConversation(conversationId);
      }

      // For events that require a session but don't have one, skip
      // (shouldn't happen once tagging is in place)
      const session = conversationId;

      const ss = session
        ? getOrCreateStreamState(streamStateRef.current, session)
        : null;

      const sealThinking = () => {
        if (!ss || !ss.thinkingMsgId) return;
        const msgId = ss.thinkingMsgId;
        const startedAt = ss.thinkingStartedAt;
        ss.thinkingMsgId = null;
        ss.thinkingStartedAt = null;
        const msgs = getMessages(session);
        const thinkMsg = msgs.find((m) => m.id === msgId);
        if (thinkMsg && !thinkMsg.content) {
          removeMessage(session, msgId);
        } else if (thinkMsg && startedAt) {
          updateMessageById(session, msgId, (m) => ({
            ...m,
            elapsedMs: Date.now() - startedAt,
          }));
        }
      };

      switch (event.type) {
        case "task_created": {
          const { task_id, conversation_id } = event.payload;
          console.debug(
            `[queue] task_created conv=${conversation_id} task=${task_id}`,
          );
          const state = getOrCreateStreamState(
            streamStateRef.current,
            conversation_id,
          );
          state.taskId = task_id;
          setTaskId(conversation_id, task_id);
          break;
        }

        case "session_start": {
          const { task_id } = event.payload;
          if (ss) ss.taskId = task_id;
          if (session) {
            setTaskId(session, task_id);
            setRunningTask(vmId, session, task_id);
          }
          break;
        }

        case "init": {
          if (!session || !ss) break;
          const id = generateId();
          ss.thinkingMsgId = id;
          ss.thinkingStartedAt = Date.now();
          ss.assistantMsgId = null;
          setStreamPhase(session, { phase: "processing" });
          chatState.setStreamStartTime?.(session, Date.now());
          addMessage(session, {
            id,
            type: "assistant",
            content: "",
            timestamp: Date.now(),
            isThinking: true,
          });
          if (ss.taskId) {
            const taskId = ss.taskId;
            schedulerRef.current.schedule(
              () => getMessages(session),
              taskId,
              session,
            );
          }
          break;
        }

        case "thinking_delta": {
          if (!session || !ss) break;
          const { thinking } = event.payload;
          setStreamPhase(session, { phase: "thinking" });
          if (ss.thinkingMsgId) {
            updateMessageById(session, ss.thinkingMsgId, (m) => ({
              ...m,
              content: m.content + thinking,
            }));
            if (ss.taskId) {
              const taskId = ss.taskId;
              schedulerRef.current.schedule(
                () => getMessages(session),
                taskId,
                session,
              );
            }
          }
          break;
        }

        case "text_delta": {
          if (!session || !ss) break;
          const { text } = event.payload;
          sealThinking();
          setStreamPhase(session, { phase: "responding" });
          // Track token estimate
          ss.estimatedTokens += Math.ceil(text.length / 4);
          chatState.setTokenUsage?.(session, {
            estimatedTokens: ss.estimatedTokens,
            contextWindow: 200_000,
          });
          if (!ss.assistantMsgId) {
            const id = generateId();
            ss.assistantMsgId = id;
            addMessage(session, {
              id,
              type: "assistant",
              content: text,
              timestamp: Date.now(),
            });
          } else {
            updateMessageById(session, ss.assistantMsgId, (m) => ({
              ...m,
              content: m.content + text,
            }));
          }
          if (ss.taskId) {
            const taskId = ss.taskId;
            schedulerRef.current.schedule(
              () => getMessages(session),
              taskId,
              session,
            );
          }
          break;
        }

        case "tool_start": {
          if (!session || !ss) break;
          const { id: toolId, name, input } = event.payload;
          sealThinking();
          ss.assistantMsgId = null;
          ss.toolIdToName.set(toolId, name);
          setStreamPhase(session, { phase: "tool_use", toolName: name });

          // Intercept plan mode tools
          if (name === "EnterPlanMode") {
            chatState.setPlanActive?.(session, true);
          }
          if (name === "ExitPlanMode") {
            chatState.setPlanActive?.(session, false);
          }

          // Intercept worktree tools
          if (name === "EnterWorktree") {
            chatState.setWorktreeActive?.(
              session,
              true,
              String(input?.name ?? ""),
            );
          }

          // Intercept TodoWrite — replaces entire task list from input
          if (name === "TodoWrite" && Array.isArray(input?.todos)) {
            const todos = input.todos as {
              content?: string;
              status?: string;
              activeForm?: string;
            }[];
            chatState.replaceTasks?.(
              session,
              todos.map((t, i) => ({
                id: String(i + 1),
                subject: String(t.content ?? ""),
                status:
                  (t.status as "pending" | "in_progress" | "completed") ??
                  "pending",
                activeForm: t.activeForm ? String(t.activeForm) : undefined,
              })),
            );
          }

          if (name === "AskUserQuestion") break;
          if (name === "TodoWrite") break;
          const msgId = generateId();
          ss.toolIdToMsgId.set(toolId, msgId);
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
          if (ss.taskId) {
            const taskId = ss.taskId;
            schedulerRef.current.schedule(
              () => getMessages(session),
              taskId,
              session,
            );
          }
          break;
        }

        case "tool_result": {
          if (!session || !ss) break;
          const { tool_use_id, content, is_error } = event.payload;
          setStreamPhase(session, { phase: "thinking" });

          // Track tokens from tool results
          ss.estimatedTokens += Math.ceil(content.length / 4);
          chatState.setTokenUsage?.(session, {
            estimatedTokens: ss.estimatedTokens,
            contextWindow: 200_000,
          });

          // Intercept task tool results (TaskCreate/TaskUpdate/TaskList/TaskGet
          // are client-side tools from Claude Code CLI; they won't appear in our
          // web app but we keep basic handling in case the tool set is extended.)
          const toolName = ss.toolIdToName.get(tool_use_id);
          if (
            toolName === "TaskCreate" ||
            toolName === "TaskUpdate" ||
            toolName === "TaskList" ||
            toolName === "TaskGet"
          ) {
            try {
              const parsed = JSON.parse(content);
              if (toolName === "TaskCreate" && parsed.task) {
                chatState.upsertTask?.(session, {
                  id: parsed.task.id,
                  subject: parsed.task.subject,
                  description: "",
                  status: "pending",
                });
              } else if (toolName === "TaskUpdate" && parsed.taskId) {
                chatState.upsertTask?.(session, {
                  id: parsed.taskId,
                  subject: "",
                  status: parsed.statusChange?.to ?? "pending",
                });
              } else if (
                (toolName === "TaskList" || toolName === "TaskGet") &&
                parsed.tasks
              ) {
                for (const t of parsed.tasks) {
                  chatState.upsertTask?.(session, {
                    id: t.id,
                    subject: t.subject,
                    status: t.status,
                    blockedBy: t.blockedBy,
                  });
                }
              }
            } catch {
              /* ignore parse errors */
            }
          }

          // Intercept worktree exit
          if (toolName === "ExitWorktree") {
            chatState.setWorktreeActive?.(session, false, "");
          }

          // Intercept TodoWrite at tool_result time — re-read todos from the
          // stored ToolMessage input (tool_result itself is just a text string).
          if (toolName === "TodoWrite") {
            const msgId = ss.toolIdToMsgId.get(tool_use_id);
            if (msgId) {
              const msgs = getMessages(session);
              const toolMsg = msgs.find((m) => m.id === msgId);
              if (
                toolMsg &&
                toolMsg.type === "tool" &&
                Array.isArray(toolMsg.toolInput?.todos)
              ) {
                const todos = toolMsg.toolInput.todos as {
                  content?: string;
                  status?: string;
                  activeForm?: string;
                }[];
                chatState.replaceTasks?.(
                  session,
                  todos.map((t, i) => ({
                    id: String(i + 1),
                    subject: String(t.content ?? ""),
                    status:
                      (t.status as "pending" | "in_progress" | "completed") ??
                      "pending",
                    activeForm: t.activeForm ? String(t.activeForm) : undefined,
                  })),
                );
              }
            }
          }

          const msgId = ss.toolIdToMsgId.get(tool_use_id);
          if (msgId) {
            updateMessageById(session, msgId, (m) => {
              if (m.type !== "tool") return m;
              return { ...m, toolResult: { content, isError: is_error } };
            });
            if (ss.taskId) {
              const taskId = ss.taskId;
              schedulerRef.current.schedule(
                () => getMessages(session),
                taskId,
                session,
              );
            }
          }
          break;
        }

        case "ask_user_question": {
          const { request_id, task_id, conversation_id, questions } =
            event.payload;
          const aqState = getOrCreateStreamState(
            streamStateRef.current,
            conversation_id,
          );
          // Seal thinking for this conversation
          if (aqState.thinkingMsgId) {
            const msgId = aqState.thinkingMsgId;
            aqState.thinkingMsgId = null;
            const msgs = getMessages(conversation_id);
            const thinkMsg = msgs.find((m) => m.id === msgId);
            if (thinkMsg && !thinkMsg.content) {
              removeMessage(conversation_id, msgId);
            }
          }
          aqState.assistantMsgId = null;
          // Stop the loading indicator — Claude is waiting for user input
          setStreamPhase(conversation_id, { phase: "idle" });
          setSessionPendingQuestion(conversation_id, {
            requestId: request_id,
            taskId: task_id,
            questions,
          });
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
          console.debug(
            `[queue] done conv=${conversation_id} task=${task_id} session=${session_id}`,
          );
          setStreamPhase(conversation_id, { phase: "idle" });
          const doneState = getOrCreateStreamState(
            streamStateRef.current,
            conversation_id,
          );
          schedulerRef.current.forceFlush(
            () => getMessages(conversation_id),
            task_id,
            conversation_id,
          );
          localStorage.removeItem(`chat_messages_task_${task_id}`);
          // Persist messages by conversationId for restoration after remount
          const msgs = getMessages(conversation_id);
          if (msgs.length > 0) {
            localStorage.setItem(
              `chat_messages_${conversation_id}`,
              JSON.stringify(msgs),
            );
          }
          doneState.taskId = null;
          removeRunningConversation(conversation_id);
          // Do not clear a pending question on done — the question panel stays
          // visible until the user explicitly answers or skips.  The answer
          // handlers (handleAnswerQuestion / handleSkipQuestion) own that cleanup.
          // Seal thinking
          if (doneState.thinkingMsgId) {
            const msgId = doneState.thinkingMsgId;
            doneState.thinkingMsgId = null;
            const msgs = getMessages(conversation_id);
            const thinkMsg = msgs.find((m) => m.id === msgId);
            if (thinkMsg && !thinkMsg.content) {
              removeMessage(conversation_id, msgId);
            }
          }
          doneState.assistantMsgId = null;
          doneState.toolIdToMsgId.clear();
          doneState.toolIdToName.clear();
          streamStateRef.current.delete(conversation_id);

          const storedQuestion = getQuestionsForConversation(conversation_id);
          if (storedQuestion) {
            clearQuestion(storedQuestion.requestId);
          }

          if (session_id) {
            updateConversation(conversation_id, { sessionId: session_id });
            loadHistory()
              .then((sessions) => {
                const match = sessions.find((s) => s.session_id === session_id);
                if (match) {
                  updateConversation(conversation_id, {
                    projectDir: match.project_dir,
                    title: match.title,
                  });
                }
              })
              .catch(console.error);
          }
          break;
        }

        case "error_event": {
          const { message } = event.payload;
          console.debug(
            `[queue] error_event conv=${session} message=${JSON.stringify(message.slice(0, 80))}`,
          );
          if (ss && ss.taskId) {
            schedulerRef.current.forceFlush(
              () => getMessages(session),
              ss.taskId,
              session ?? undefined,
            );
            localStorage.removeItem(`chat_messages_task_${ss.taskId}`);
            ss.taskId = null;
          }
          if (session) {
            setStreamPhase(session, { phase: "idle" });
            removeRunningConversation(session);
            removeRunningTask(vmId, session);
            // Do not clear a pending question on connection drop — the server
            // may still be waiting for the user's answer, so preserve it.
            // The question is cleared when the user answers or when `done` fires.
            streamStateRef.current.delete(session);
          }
          // If no session tagged, remove all running (fallback for untagged errors)
          addMessage(session, {
            id: generateId(),
            type: "error",
            content: message,
            timestamp: Date.now(),
          });
          break;
        }

        case "query_aborted": {
          const abortedId = event.conversationId;
          console.debug(`[queue] query_aborted conv=${abortedId}`);
          setStreamPhase(abortedId, { phase: "idle" });
          removeRunningConversation(abortedId);
          streamStateRef.current.delete(abortedId);
          break;
        }

        case "heartbeat":
          // Activity touch already happened at the top of handleEvent.
          break;

        case "reconnecting": {
          const { task_id, conversation_id } = event.payload;
          const rcState = getOrCreateStreamState(
            streamStateRef.current,
            conversation_id,
          );
          if (rcState.taskId === task_id) break;
          rcState.taskId = task_id;
          setTaskId(conversation_id, task_id);
          addRunningConversation(conversation_id);
          setViewConversationId(conversation_id);

          let inProgressMessages: ChatMessage[] = [];
          const savedMessages = localStorage.getItem(
            `chat_messages_task_${task_id}`,
          );
          if (savedMessages) {
            try {
              inProgressMessages = safeJsonParse<ChatMessage[]>(savedMessages);
              setMessages(conversation_id, inProgressMessages);
            } catch {
              /* ignore parse errors */
            }
          }
          if (inProgressMessages.length === 0) {
            const convMessages = localStorage.getItem(
              `chat_messages_${conversation_id}`,
            );
            if (convMessages) {
              try {
                inProgressMessages = safeJsonParse<ChatMessage[]>(convMessages);
                setMessages(conversation_id, inProgressMessages);
              } catch {
                /* ignore parse errors */
              }
            }
          }

          const conversation = conversationsRef.current.find(
            (c) => c.conversationId === conversation_id,
          );
          if (conversation?.sessionId && conversation?.projectDir) {
            loadTranscript(conversation.sessionId, conversation.projectDir)
              .then((transcript) => {
                const historical = buildMessagesFromTranscript(transcript);
                if (historical.length > 0) {
                  setMessages(conversation_id, [
                    ...historical,
                    ...inProgressMessages,
                  ]);
                }
              })
              .catch(console.error);
          }
          break;
        }
      }
    }
  }, [eventSeq]); // eslint-disable-line react-hooks/exhaustive-deps
}
