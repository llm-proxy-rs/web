import React, { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { twMerge } from "tailwind-merge";
import type { ChatMessage } from "../types";
import MessageCopyControl from "./MessageCopyControl";
import ToolRenderer from "./ToolRenderer";

interface MessageComponentProps {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
}

const MessageComponent = memo(({ message, prevMessage }: MessageComponentProps) => {
  const isGrouped =
    prevMessage !== null &&
    prevMessage.type === message.type &&
    message.type !== "tool" &&
    prevMessage.type !== "tool";

  const formattedTime = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const [hovered, setHovered] = useState(false);

  if (message.type === "user") {
    return (
      <div
        className="flex justify-end px-4 py-0.5"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="max-w-[75%] sm:max-w-lg">
          <div className="rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground shadow-sm">
            <div className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</div>
          </div>
          <div className="mt-1 flex items-center justify-end gap-2 pr-1">
            {hovered && <MessageCopyControl content={message.content} messageType="user" />}
            <span className="text-[10px] text-muted-foreground/50">{formattedTime}</span>
          </div>
        </div>
      </div>
    );
  }

  if (message.type === "error") {
    return (
      <div className="px-4 py-0.5">
        <div className="rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-sm text-destructive">
          <span className="font-medium">Error: </span>{message.content}
        </div>
      </div>
    );
  }

  if (message.type === "assistant" && message.isThinking) {
    if (!message.content) {
      return (
        <div className="px-4 py-1">
          <ThinkingIndicator />
        </div>
      );
    }
    return (
      <div className="px-4 py-0.5">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <svg
              className="h-3 w-3 transition-transform group-open:rotate-90"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Thinking…
          </summary>
          <div className="mt-2 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
            <div className="whitespace-pre-wrap">{message.content}</div>
          </div>
        </details>
      </div>
    );
  }

  if (message.type === "tool") {
    return (
      <div className="px-4 py-0.5">
        <ToolRenderer
          toolName={message.toolName}
          toolInput={message.toolInput}
          toolResult={message.toolResult}
        />
      </div>
    );
  }

  // Regular assistant message
  return (
    <div
      className={twMerge("px-4", isGrouped ? "py-0.5" : "py-1")}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {!isGrouped && (
        <div className="mb-2 flex items-center gap-2.5">
          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-bold tracking-wider text-primary-foreground shadow-sm">
            AI
          </div>
          <span className="text-xs font-semibold text-foreground">Claude</span>
          <span className="text-[10px] text-muted-foreground/60">{formattedTime}</span>
          <div className="ml-auto">
            {hovered && <MessageCopyControl content={message.content} messageType="assistant" />}
          </div>
        </div>
      )}
      <div className={twMerge("min-w-0 overflow-x-auto text-sm leading-relaxed text-foreground", isGrouped ? "" : "pl-[34px]")}>
        <MarkdownContent content={message.content} />
      </div>
      {isGrouped && (
        <div className={`flex justify-end pt-0.5 pl-[34px] transition-opacity duration-150 ${hovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
          <MessageCopyControl content={message.content} messageType="assistant" />
        </div>
      )}
    </div>
  );
});

MessageComponent.displayName = "MessageComponent";

export default MessageComponent;

function MarkdownContent({ content }: { content: string }) {
  if (content === "__FORCE_RENDER_ERROR__") {
    throw new Error("Forced render error for testing");
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-gray-900 prose-pre:border prose-pre:border-border prose-code:text-sm"
    >
      {content}
    </ReactMarkdown>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-bold tracking-wider text-primary-foreground">
        AI
      </div>
      <div className="flex items-center gap-1 rounded-full bg-muted px-3 py-1.5">
        <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
        <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
        <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
      </div>
    </div>
  );
}
