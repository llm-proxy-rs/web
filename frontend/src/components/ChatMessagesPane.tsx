import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ChatMessage } from "../types";
import MessageComponent from "./MessageComponent";
import MessageErrorBoundary from "./MessageErrorBoundary";

interface ChatMessagesPaneProps {
  messages: ChatMessage[];
  isLoading: boolean;
}

export default function ChatMessagesPane({ messages, isLoading }: ChatMessagesPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  useEffect(() => {
    if (userScrolledRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const handleWheel = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledRef.current = !atBottom;
    setShowScrollBtn(!atBottom);
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) {
      userScrolledRef.current = false;
      setShowScrollBtn(false);
    }
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    userScrolledRef.current = false;
    setShowScrollBtn(false);
  };

  if (messages.length === 0 && !isLoading) {
    return (
      <div ref={scrollRef} className="flex flex-1 items-center justify-center overflow-y-auto">
        <div className="text-center">
          <div className="mb-4 text-5xl opacity-10">◈</div>
          <p className="text-sm font-medium text-muted-foreground">Start a new conversation</p>
          <p className="mt-1 text-xs text-muted-foreground/50">Type a message below to begin</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onWheel={handleWheel}
        onScroll={handleScroll}
        className="h-full space-y-1 overflow-y-auto py-4"
      >
        {messages.map((message, index) => {
          const prevMessage = index > 0 ? messages[index - 1] : null;
          return (
            <div key={message.id} className="message-slide-in">
              <MessageErrorBoundary>
                <MessageComponent message={message} prevMessage={prevMessage} />
              </MessageErrorBoundary>
            </div>
          );
        })}
      </div>

      {showScrollBtn && (
        <button
          type="button"
          onClick={scrollToBottom}
          title="Scroll to bottom"
          className="absolute bottom-4 right-4 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
