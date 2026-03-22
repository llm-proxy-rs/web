import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
} from "react";
import { ChevronDown } from "lucide-react";
import type { ChatMessage } from "../types";
import MessageComponent from "./MessageComponent";
import MessageCopyControl from "./MessageCopyControl";
import MessageErrorBoundary from "./MessageErrorBoundary";

interface ChatMessagesPaneProps {
  messages: ChatMessage[];
  isLoading: boolean;
  autoScrollToBottom?: boolean;
  showThinking?: boolean;
  autoExpandTools?: boolean;
}

/** A "turn group" is a sequence of assistant + tool messages between user messages. */
type TurnGroup =
  | { kind: "user" | "error"; message: ChatMessage }
  | { kind: "assistant-turn"; messages: ChatMessage[]; firstTimestamp: number };

function groupIntoTurns(messages: ChatMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let currentTurn: ChatMessage[] | null = null;

  const flushTurn = () => {
    if (currentTurn && currentTurn.length > 0) {
      groups.push({
        kind: "assistant-turn",
        messages: currentTurn,
        firstTimestamp: currentTurn[0].timestamp,
      });
      currentTurn = null;
    }
  };

  for (const msg of messages) {
    if (msg.type === "assistant" || msg.type === "tool") {
      if (!currentTurn) currentTurn = [];
      currentTurn.push(msg);
    } else {
      flushTurn();
      groups.push({
        kind: msg.type === "user" ? "user" : "error",
        message: msg,
      });
    }
  }
  flushTurn();
  return groups;
}

const AssistantTurnCard = React.memo(function AssistantTurnCard({
  messages,
  showThinking,
  autoExpandTools,
}: {
  messages: ChatMessage[];
  showThinking?: boolean;
  autoExpandTools?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const firstMsg = messages[0];
  const formattedTime = new Date(firstMsg.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  // Concatenate all assistant text content in this turn for the copy button
  const fullText = messages
    .filter(
      (m) => m.type === "assistant" && !("isThinking" in m && m.isThinking),
    )
    .map((m) => m.content)
    .join("\n\n");

  return (
    <div
      data-testid="assistant-card"
      className="mx-4 my-2.5 rounded-2xl bg-card px-5 py-5 shadow-lg shadow-black/8 ring-1 ring-border/40"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Card header */}
      <div className="mb-3.5 flex items-center gap-2.5">
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-bold tracking-wider text-primary-foreground shadow-sm shadow-primary/20">
          AI
        </div>
        <span className="text-sm font-semibold text-foreground">Claude</span>
        <span className="text-xs text-muted-foreground/50">
          {formattedTime}
        </span>
        {hovered && fullText && (
          <span className="fade-in">
            <MessageCopyControl content={fullText} messageType="assistant" />
          </span>
        )}
      </div>

      {/* Card body — all messages in this turn */}
      <div className="space-y-1">
        {messages.map((msg) => (
          <MessageErrorBoundary key={msg.id}>
            <MessageComponent
              message={msg}
              prevMessage={null}
              insideCard
              showThinking={showThinking}
              autoExpandTools={autoExpandTools}
            />
          </MessageErrorBoundary>
        ))}
      </div>
    </div>
  );
});

export default function ChatMessagesPane({
  messages,
  isLoading,
  autoScrollToBottom,
  showThinking,
  autoExpandTools,
}: ChatMessagesPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const rafRef = useRef<number | null>(null);

  const turnGroups = useMemo(() => groupIntoTurns(messages), [messages]);

  useEffect(() => {
    if (autoScrollToBottom === false) return;
    if (userScrolledRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, isLoading]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handleScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledRef.current = !atBottom;
      setShowScrollBtn(!atBottom);
    });
  }, []);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    userScrolledRef.current = false;
    setShowScrollBtn(false);
  };

  if (messages.length === 0 && !isLoading) {
    return (
      <div
        ref={scrollRef}
        className="flex flex-1 items-center justify-center overflow-y-auto"
      >
        <div className="fade-in flex flex-col items-center gap-3">
          <div className="relative">
            <div className="pulse-glow absolute -inset-3 rounded-full bg-primary/20 blur-xl" />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary text-sm font-bold tracking-wider text-primary-foreground shadow-lg shadow-primary/25">
              AI
            </div>
          </div>
          <p className="text-lg font-semibold text-foreground">Welcome back!</p>
          <p className="text-sm text-muted-foreground/60">
            What shall we explore today?
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Top gradient overlay */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background to-transparent" />
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full space-y-1 overflow-y-auto py-4"
      >
        <div className="mx-auto max-w-4xl">
          {turnGroups.map((group, i) => {
            if (group.kind === "assistant-turn") {
              return (
                <div
                  key={`turn-${group.messages[0].id}`}
                  className="message-slide-in"
                >
                  <AssistantTurnCard
                    messages={group.messages}
                    showThinking={showThinking}
                    autoExpandTools={autoExpandTools}
                  />
                </div>
              );
            }
            const msg = group.message;
            return (
              <div key={msg.id} className="message-slide-in">
                <MessageErrorBoundary>
                  <MessageComponent
                    message={msg}
                    prevMessage={null}
                    showThinking={showThinking}
                    autoExpandTools={autoExpandTools}
                  />
                </MessageErrorBoundary>
              </div>
            );
          })}
        </div>
      </div>
      {/* Bottom gradient overlay */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-background to-transparent" />

      {showScrollBtn && (
        <button
          type="button"
          onClick={scrollToBottom}
          title="Scroll to bottom"
          className="scale-in absolute bottom-4 right-4 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/35"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
