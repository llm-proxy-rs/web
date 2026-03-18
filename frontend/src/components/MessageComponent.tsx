import React, { memo, useEffect, useRef, useState } from "react";
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

const MessageComponent = memo(
  ({ message, prevMessage }: MessageComponentProps) => {
    const isGrouped =
      prevMessage !== null &&
      prevMessage.type === message.type &&
      message.type !== "tool" &&
      prevMessage.type !== "tool" &&
      !(message.type === "assistant" &&
        prevMessage.type === "assistant" &&
        (("isThinking" in message && message.isThinking) ||
          ("isThinking" in prevMessage && prevMessage.isThinking)));

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
          <div className="relative max-w-[75%] sm:max-w-lg">
            {hovered && (
              <div className="absolute -left-8 top-1">
                <MessageCopyControl
                  content={message.content}
                  messageType="user"
                />
              </div>
            )}
            <div className="rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground shadow-sm">
              <div className="whitespace-pre-wrap break-words leading-relaxed">
                {message.content}
              </div>
            </div>
            <div className="mt-0.5 pr-0.5 text-right">
              <span className="text-[10px] text-muted-foreground/50">
                {formattedTime}
              </span>
            </div>
          </div>
        </div>
      );
    }

    if (message.type === "error") {
      return (
        <div className="px-4 py-0.5">
          <div className="rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-sm text-destructive">
            <span className="font-medium">Error: </span>
            {message.content}
          </div>
        </div>
      );
    }

    if (message.type === "assistant" && message.isThinking) {
      return null;
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
            <span className="text-xs font-semibold text-foreground">
              Claude
            </span>
            <span className="text-[10px] text-muted-foreground/60">
              {formattedTime}
            </span>
            {hovered && (
              <MessageCopyControl
                content={message.content}
                messageType="assistant"
              />
            )}
          </div>
        )}
        <div className="relative">
          {isGrouped && hovered && (
            <div className="absolute -left-7 top-0">
              <MessageCopyControl
                content={message.content}
                messageType="assistant"
              />
            </div>
          )}
          <div
            className={twMerge(
              "min-w-0 overflow-x-auto text-sm leading-relaxed text-foreground",
              isGrouped ? "" : "pl-[34px]",
            )}
          >
            <MarkdownContent content={message.content} />
          </div>
        </div>
      </div>
    );
  },
);

MessageComponent.displayName = "MessageComponent";

export default MessageComponent;

function CodeBlock(props: React.ComponentPropsWithoutRef<"pre">) {
  const { children, ...rest } = props;
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  let language = "";
  const codeChild = React.Children.toArray(children).find(
    (child): child is React.ReactElement =>
      React.isValidElement(child) &&
      (child as React.ReactElement).type === "code",
  );
  if (codeChild) {
    const cls =
      (codeChild.props as { className?: string }).className || "";
    const match = cls.match(/language-(\w+)/);
    if (match) language = match[1];
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    const text = preRef.current?.textContent || "";
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  return (
    <div className="not-prose my-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between bg-accent/60 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy code"}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? (
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre
        ref={preRef}
        {...rest}
        className="m-0 overflow-x-auto rounded-none border-0 bg-muted p-3 text-[0.8125rem] leading-[1.7]"
      >
        {children}
      </pre>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  if (content === "__FORCE_RENDER_ERROR__") {
    throw new Error("Forced render error for testing");
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      className="prose prose-sm max-w-none dark:prose-invert prose-code:text-sm"
      components={{ pre: CodeBlock }}
    >
      {content}
    </ReactMarkdown>
  );
}
