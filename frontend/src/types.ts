export interface Conversation {
  conversationId: string;
  sessionId?: string;
  projectDir?: string;
  title?: string;
  createdAt: number;
}

export interface ChatSession {
  session_id: string;
  created_at: string;
  title: string;
  project_dir?: string;
  is_pending?: boolean;
}

export interface TranscriptMessage {
  role: string;
  content: string | ContentBlock[];
  isCompactSummary: boolean;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  requestId: string;
  taskId: string;
  questions: Question[];
}

export interface StoredQuestion {
  conversationId: string;
  taskId: string;
  requestId: string;
  questions: Question[];
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

interface BaseMessage {
  id: string;
  timestamp: number;
}

export interface UserMessage extends BaseMessage {
  type: "user";
  content: string;
}

export interface AssistantMessage extends BaseMessage {
  type: "assistant";
  content: string;
  isThinking?: boolean;
}

export interface ToolMessage extends BaseMessage {
  type: "tool";
  content: string;
  isToolUse: true;
  toolId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: ToolResult;
}

export interface ErrorMessage extends BaseMessage {
  type: "error";
  content: string;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage | ErrorMessage;

// SSE event payloads
export interface SseTextDelta {
  text: string;
}

export interface SseThinkingDelta {
  thinking: string;
}

export interface SseToolStart {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface SseSessionStart {
  task_id: string;
}

export interface SseTaskCreated {
  task_id: string;
  conversation_id: string;
}

export interface SseAskUserQuestion {
  request_id: string;
  task_id: string;
  conversation_id: string;
  questions: Question[];
}

export interface SseToolResult {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export interface SseDone {
  session_id: string | null;
  task_id: string;
  conversation_id: string;
}

export interface SseErrorEvent {
  message: string;
}

export type SseEvent =
  | { type: "task_created"; payload: SseTaskCreated }
  | { type: "session_start"; payload: SseSessionStart }
  | { type: "init" }
  | { type: "text_delta"; payload: SseTextDelta }
  | { type: "thinking_delta"; payload: SseThinkingDelta }
  | { type: "tool_start"; payload: SseToolStart }
  | { type: "ask_user_question"; payload: SseAskUserQuestion }
  | { type: "tool_result"; payload: SseToolResult }
  | { type: "done"; payload: SseDone }
  | { type: "error_event"; payload: SseErrorEvent }
  | { type: "reconnecting"; payload: { task_id: string; conversation_id: string } };

export interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

export type ViewTab = "chat" | "terminal" | "files";
