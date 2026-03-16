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

export function parseSseBlock(part: string): { eventName: string; data: string } | null {
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
    payload = JSON.parse(data);
  } catch {
    return;
  }
  switch (eventName) {
    case "task_created":
      pushEvent({ type: "task_created", payload: payload as SseTaskCreated });
      break;
    case "session_start":
      pushEvent({ type: "session_start", payload: payload as SseSessionStart });
      break;
    case "init":
      pushEvent({ type: "init" });
      break;
    case "text_delta":
      pushEvent({ type: "text_delta", payload: payload as SseTextDelta });
      break;
    case "thinking_delta":
      pushEvent({ type: "thinking_delta", payload: payload as SseThinkingDelta });
      break;
    case "tool_start":
      pushEvent({ type: "tool_start", payload: payload as SseToolStart });
      break;
    case "ask_user_question":
      pushEvent({ type: "ask_user_question", payload: payload as SseAskUserQuestion });
      break;
    case "tool_result":
      pushEvent({ type: "tool_result", payload: payload as SseToolResult });
      break;
    case "done":
      localStorage.removeItem(`chat_running_task_${vmId}`);
      pushEvent({ type: "done", payload: payload as SseDone });
      break;
    case "error_event":
      localStorage.removeItem(`chat_running_task_${vmId}`);
      pushEvent({ type: "error_event", payload: payload as SseErrorEvent });
      break;
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
      for (const part of parts) {
        if (!part.trim()) continue;
        const block = parseSseBlock(part);
        if (block) {
          dispatchSseEvent(block.eventName, block.data, pushEvent, vmId);
        }
      }
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
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  add("task_created", (e) => { const p = safeParse(e.data); if (p !== undefined) pushEvent({ type: "task_created", payload: p as SseTaskCreated }); });
  add("session_start", (e) => { const p = safeParse(e.data); if (p !== undefined) pushEvent({ type: "session_start", payload: p as SseSessionStart }); });
  add("init", () => pushEvent({ type: "init" }));
  add("text_delta", (e) => { const p = safeParse(e.data); if (p !== undefined) pushEvent({ type: "text_delta", payload: p as SseTextDelta }); });
  add("thinking_delta", (e) => { const p = safeParse(e.data); if (p !== undefined) pushEvent({ type: "thinking_delta", payload: p as SseThinkingDelta }); });
  add("tool_start", (e) => { const p = safeParse(e.data); if (p !== undefined) pushEvent({ type: "tool_start", payload: p as SseToolStart }); });
  add("ask_user_question", (e) => { const p = safeParse(e.data); if (p !== undefined) pushEvent({ type: "ask_user_question", payload: p as SseAskUserQuestion }); });
  add("tool_result", (e) => { const p = safeParse(e.data); if (p !== undefined) pushEvent({ type: "tool_result", payload: p as SseToolResult }); });
  add("done", (e) => {
    const p = safeParse(e.data);
    if (p === undefined) return;
    localStorage.removeItem(`chat_running_task_${vmId}`);
    pushEvent({ type: "done", payload: p as SseDone });
  });
  add("error_event", (e) => {
    const p = safeParse(e.data);
    if (p === undefined) return;
    localStorage.removeItem(`chat_running_task_${vmId}`);
    pushEvent({ type: "error_event", payload: p as SseErrorEvent });
  });
  es.onerror = () => {
    es.close();
  };
}
