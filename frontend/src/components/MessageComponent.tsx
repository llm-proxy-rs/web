import React, { memo, useMemo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { twMerge } from "tailwind-merge";
import type { ChatMessage } from "../types";
import MessageCopyControl from "./MessageCopyControl";
import ToolRenderer from "./ToolRenderer";

interface MessageComponentProps {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  insideCard?: boolean;
  showThinking?: boolean;
  autoExpandTools?: boolean;
}

const MessageComponent = memo(
  ({
    message,
    prevMessage,
    insideCard,
    showThinking,
    autoExpandTools,
  }: MessageComponentProps) => {
    const isGrouped =
      prevMessage !== null &&
      prevMessage.type === message.type &&
      message.type !== "tool" &&
      prevMessage.type !== "tool" &&
      !(
        message.type === "assistant" &&
        prevMessage.type === "assistant" &&
        (("isThinking" in message && message.isThinking) ||
          ("isThinking" in prevMessage && prevMessage.isThinking))
      );

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
              <div className="fade-in absolute -left-8 top-1">
                <MessageCopyControl
                  content={message.content}
                  messageType="user"
                />
              </div>
            )}
            <div className="rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-base text-primary-foreground shadow-lg shadow-primary/20 ring-1 ring-primary/25">
              <div className="whitespace-pre-wrap break-words leading-relaxed">
                {message.content}
              </div>
            </div>
            <div className="mt-1 pr-0.5 text-right">
              <span className="text-[11px] tracking-wide text-muted-foreground/35">
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
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-base text-destructive shadow-sm">
            <span className="font-semibold">Error: </span>
            {message.content}
          </div>
        </div>
      );
    }

    if (message.type === "assistant" && message.isThinking) {
      if (showThinking === false) return null;
      if (!message.content) return null;
      return (
        <div className={insideCard ? "py-0.5" : "px-4 py-0.5"}>
          <details className="group rounded-xl border border-primary/12 bg-primary/4 px-3 py-2.5">
            <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
              Thinking
            </summary>
            <div className="mt-2 whitespace-pre-wrap text-sm italic text-muted-foreground leading-relaxed">
              {message.content}
            </div>
          </details>
        </div>
      );
    }

    if (message.type === "tool") {
      return (
        <div className={insideCard ? "py-0.5" : "px-4 py-0.5"}>
          <ToolRenderer
            toolName={message.toolName}
            toolInput={message.toolInput}
            toolResult={message.toolResult}
            autoExpandTools={autoExpandTools}
          />
        </div>
      );
    }

    // Regular assistant message
    if (insideCard) {
      // Rendered inside an assistant card — no header, no copy button (card header handles it)
      return (
        <div className="py-0.5">
          <div className="min-w-0 overflow-x-auto text-base leading-relaxed text-foreground">
            <MarkdownContent content={message.content} />
          </div>
        </div>
      );
    }

    // Standalone assistant message (outside card, e.g. transcript view)
    return (
      <div
        className={twMerge("px-4", isGrouped ? "py-0.5" : "py-1")}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {!isGrouped && (
          <div className="mb-2 flex items-center gap-2.5">
            <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-bold tracking-wider text-primary-foreground shadow-sm shadow-primary/20">
              AI
            </div>
            <span className="text-sm font-semibold text-foreground">
              Claude
            </span>
            <span className="text-xs text-muted-foreground/50">
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

type CodeBlockProps = {
  node?: any;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
};

function CodeBlock({
  node,
  inline,
  className,
  children,
  ...props
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const raw = Array.isArray(children)
    ? children.join("")
    : String(children ?? "");
  const looksMultiline = /[\r\n]/.test(raw);
  const inlineDetected = inline || (node && node.type === "inlineCode");
  const shouldInline = inlineDetected || !looksMultiline;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (shouldInline) {
    return (
      <code
        className={twMerge(
          "whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 font-mono text-[0.9em]",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1] : "text";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  return (
    <div className="not-prose group relative my-3 overflow-hidden rounded-xl ring-1 ring-border/30">
      {language && language !== "text" && (
        <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-muted-foreground/50">
          {language}
        </div>
      )}
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy code"}
        aria-label={copied ? "Copied!" : "Copy code"}
        className="absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/90 px-2 py-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-card hover:text-foreground focus:opacity-100 group-hover:opacity-100"
      >
        {copied ? (
          <>
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            Copied!
          </>
        ) : (
          <>
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
            Copy
          </>
        )}
      </button>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: "0.75rem",
          fontSize: "0.875rem",
          padding:
            language && language !== "text" ? "2rem 1rem 1rem 1rem" : "1rem",
        }}
        codeTagProps={{
          style: {
            fontFamily:
              '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          },
        }}
      >
        {raw}
      </SyntaxHighlighter>
    </div>
  );
}

const markdownComponents = {
  code: CodeBlock,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-4 border-primary/30 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      className="text-primary underline decoration-primary/30 underline-offset-[3px] hover:decoration-primary"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <div className="mb-2 last:mb-0">{children}</div>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-border/50 bg-muted/20">
      <table className="min-w-full border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-primary/8 border-b-2 border-primary/15">
      {children}
    </thead>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="border-b border-border/30 even:bg-muted/30">{children}</tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-4 py-2.5 text-left text-[0.9375rem] font-semibold">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-4 py-2.5 align-top text-[0.9375rem]">{children}</td>
  ),
};

function MarkdownContent({ content }: { content: string }) {
  if (content === "__FORCE_RENDER_ERROR__") {
    throw new Error("Forced render error for testing");
  }
  const remarkPlugins = useMemo(() => [remarkGfm, remarkBreaks], []);
  const rehypePlugins = useMemo(
    () => [
      [
        rehypeSanitize,
        {
          ...defaultSchema,
          attributes: {
            ...defaultSchema.attributes,
            code: [
              ...(defaultSchema.attributes?.code ?? []),
              ["className", /^language-[\w]+$/],
            ],
          },
        },
      ],
    ],
    [],
  );
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins as any}
      className="prose max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-headings:mt-4 prose-headings:mb-2"
      components={markdownComponents as any}
    >
      {content}
    </ReactMarkdown>
  );
}
