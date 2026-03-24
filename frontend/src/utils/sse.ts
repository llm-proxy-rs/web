import type {
  SseAskUserQuestion,
  SseDone,
  SseErrorEvent,
  SseEvent,
  SseSessionStart,
  SseTaskCreated,
  SseTextDelta,
  SseThinkingDelta,
  SseToolResult,
  SseToolStart,
} from "../types";
import { safeJsonParse } from "./safeJson";

/** Lightweight runtime check that an unknown value has the expected string/object fields. */
function hasFields(
  obj: unknown,
  fields: string[],
): obj is Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  return fields.every((f) => f in rec);
}

/** Validate and cast an SSE payload for a given event type.  Returns null if
 *  the payload doesn't have the required discriminating fields. */
function validatePayload(eventName: string, payload: unknown): SseEvent | null {
  switch (eventName) {
    case "task_created":
      if (!hasFields(payload, ["task_id", "conversation_id"])) return null;
      return { type: "task_created", payload: payload as SseTaskCreated };
    case "session_start":
      if (!hasFields(payload, ["task_id"])) return null;
      return { type: "session_start", payload: payload as SseSessionStart };
    case "init":
      return { type: "init" };
    case "text_delta":
      if (!hasFields(payload, ["text"])) return null;
      return { type: "text_delta", payload: payload as SseTextDelta };
    case "thinking_delta":
      if (!hasFields(payload, ["thinking"])) return null;
      return { type: "thinking_delta", payload: payload as SseThinkingDelta };
    case "tool_start":
      if (!hasFields(payload, ["id", "name"])) return null;
      return { type: "tool_start", payload: payload as SseToolStart };
    case "ask_user_question":
      if (!hasFields(payload, ["request_id", "task_id", "questions"]))
        return null;
      return {
        type: "ask_user_question",
        payload: payload as SseAskUserQuestion,
      };
    case "tool_result":
      if (!hasFields(payload, ["tool_use_id", "content"])) return null;
      return { type: "tool_result", payload: payload as SseToolResult };
    case "done":
      if (!hasFields(payload, ["task_id", "conversation_id"])) return null;
      return { type: "done", payload: payload as SseDone };
    case "error_event":
      if (!hasFields(payload, ["message"])) return null;
      return { type: "error_event", payload: payload as SseErrorEvent };
    default:
      return null;
  }
}

export function parseSseBlock(
  part: string,
): { eventName: string; data: string } | null {
  let eventName = "";
  let data = "";
  for (const line of part.split("\n")) {
    if (line.startsWith("event: ")) {
      eventName = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      data += (data ? "\n" : "") + line.slice(6);
    }
  }
  return eventName && data ? { eventName, data } : null;
}

export function dispatchSseEvent(
  eventName: string,
  data: string,
  pushEvent: (e: SseEvent) => void,
  vmId: string,
): void {
  let payload: unknown;
  try {
    payload = safeJsonParse(data);
  } catch (e) {
    console.warn("Failed to parse SSE data as JSON", e);
    return;
  }
  switch (eventName) {
    case "task_created":
    case "session_start":
    case "text_delta":
    case "thinking_delta":
    case "tool_start":
    case "ask_user_question":
    case "tool_result": {
      const event = validatePayload(eventName, payload);
      if (event) pushEvent(event);
      break;
    }
    case "init": {
      pushEvent({ type: "init" });
      break;
    }
    case "done": {
      const event = validatePayload(eventName, payload);
      if (!event) return;
      localStorage.removeItem(`chat_running_task_${vmId}`);
      pushEvent(event);
      break;
    }
    case "error_event": {
      const event = validatePayload(eventName, payload);
      if (!event) return;
      localStorage.removeItem(`chat_running_task_${vmId}`);
      pushEvent(event);
      break;
    }
  }
}

export async function readFetchSseStream(
  response: Response,
  pushEvent: (e: SseEvent) => void,
  vmId: string,
): Promise<void> {
  if (!response.body) throw new Error("response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      let streamEnded = false;
      for (const part of parts) {
        if (!part.trim()) continue;
        const block = parseSseBlock(part);
        if (block) {
          dispatchSseEvent(block.eventName, block.data, pushEvent, vmId);
          if (block.eventName === "done" || block.eventName === "error_event") {
            streamEnded = true;
          }
        }
      }
      if (streamEnded) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export function attachEventSourceListeners(
  es: EventSource,
  pushEvent: (e: SseEvent) => void,
  vmId: string,
): void {
  const add = (name: string, handler: (e: MessageEvent) => void) => {
    es.addEventListener(name, handler as EventListener);
  };
  const safeParse = (raw: string): unknown => {
    try {
      return safeJsonParse(raw);
    } catch {
      return undefined;
    }
  };
  add("task_created", (e) => {
    const p = safeParse(e.data);
    const event = p !== undefined ? validatePayload("task_created", p) : null;
    if (event) pushEvent(event);
  });
  add("session_start", (e) => {
    const p = safeParse(e.data);
    const event = p !== undefined ? validatePayload("session_start", p) : null;
    if (event) pushEvent(event);
  });
  add("init", () => pushEvent({ type: "init" }));
  add("text_delta", (e) => {
    const p = safeParse(e.data);
    const event = p !== undefined ? validatePayload("text_delta", p) : null;
    if (event) pushEvent(event);
  });
  add("thinking_delta", (e) => {
    const p = safeParse(e.data);
    const event = p !== undefined ? validatePayload("thinking_delta", p) : null;
    if (event) pushEvent(event);
  });
  add("tool_start", (e) => {
    const p = safeParse(e.data);
    const event = p !== undefined ? validatePayload("tool_start", p) : null;
    if (event) pushEvent(event);
  });
  add("ask_user_question", (e) => {
    const p = safeParse(e.data);
    const event =
      p !== undefined ? validatePayload("ask_user_question", p) : null;
    if (event) pushEvent(event);
  });
  add("tool_result", (e) => {
    const p = safeParse(e.data);
    const event = p !== undefined ? validatePayload("tool_result", p) : null;
    if (event) pushEvent(event);
  });
  add("done", (e) => {
    const p = safeParse(e.data);
    const event = p !== undefined ? validatePayload("done", p) : null;
    if (!event) return;
    localStorage.removeItem(`chat_running_task_${vmId}`);
    pushEvent(event);
  });
  add("error_event", (e) => {
    const p = safeParse(e.data);
    const event = p !== undefined ? validatePayload("error_event", p) : null;
    if (!event) return;
    localStorage.removeItem(`chat_running_task_${vmId}`);
    pushEvent(event);
  });
  es.onerror = () => {
    es.close();
  };
}
