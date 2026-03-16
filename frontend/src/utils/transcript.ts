import type { ChatMessage, ContentBlock, ToolMessage, TranscriptMessage } from "../types";

function extractToolResultContent(raw: string | ContentBlock[] | undefined): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  return raw.map((b) => b.text ?? "").join("");
}

export function buildMessagesFromTranscript(transcript: TranscriptMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let id = 0;
  const nextId = () => `t${id++}`;

  // toolId → index in messages array, for attaching tool results
  const toolIdToIndex = new Map<string, number>();

  for (const entry of transcript) {
    const role = entry.role;

    if (role === "user") {
      const blocks = typeof entry.content === "string" ? null : entry.content;
      if (blocks) {
        // Attach tool results to their corresponding tool use messages
        for (const block of blocks) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const idx = toolIdToIndex.get(block.tool_use_id);
            if (idx !== undefined) {
              const existing = messages[idx];
              if (existing.type === "tool") {
                messages[idx] = {
                  ...existing,
                  toolResult: {
                    content: extractToolResultContent(block.content),
                    isError: block.is_error ?? false,
                  },
                };
              }
            }
          }
        }
        // Also collect any plain text from user turns
        const text = blocks.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
        if (text.trim()) {
          messages.push({ id: nextId(), type: "user", content: text, timestamp: Date.now() });
        }
      } else if (typeof entry.content === "string" && entry.content.trim()) {
        messages.push({ id: nextId(), type: "user", content: entry.content, timestamp: Date.now() });
      }
    } else if (role === "assistant") {
      const blocks = typeof entry.content === "string"
        ? [{ type: "text", text: entry.content }]
        : entry.content;

      for (const block of blocks) {
        if (block.type === "thinking" && block.thinking) {
          messages.push({
            id: nextId(),
            type: "assistant",
            content: block.thinking,
            timestamp: Date.now(),
            isThinking: true,
          });
        } else if (block.type === "text" && block.text) {
          messages.push({
            id: nextId(),
            type: "assistant",
            content: block.text,
            timestamp: Date.now(),
          });
        } else if (block.type === "tool_use") {
          const msgIdx = messages.length;
          if (block.id) toolIdToIndex.set(block.id, msgIdx);
          messages.push({
            id: nextId(),
            type: "tool",
            content: "",
            timestamp: Date.now(),
            isToolUse: true,
            toolId: block.id ?? "",
            toolName: block.name ?? "",
            toolInput: (block.input as Record<string, unknown>) ?? {},
          } satisfies ToolMessage);
        }
      }
    }
  }
  return messages;
}
