import React, { useState } from "react";
import { Plus, RotateCw, Search, Trash2, X } from "lucide-react";
import type { Conversation } from "../types";

interface SidebarProps {
  conversations: Conversation[];
  viewConversationId: string | null;
  runningConversationIds: Set<string>;
  onSelectConversation: (conversation: Conversation) => void;
  onNewChat: () => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onRefresh: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function Sidebar({
  conversations,
  viewConversationId,
  runningConversationIds,
  onSelectConversation,
  onNewChat,
  onDeleteConversation,
  onRefresh,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = conversations.filter(
    (c) =>
      !searchQuery ||
      c.title?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleSelect = (conversation: Conversation) => {
    onSelectConversation(conversation);
    onMobileClose?.();
  };

  return (
    <>
      {/* Mobile overlay backdrop */}
      {mobileOpen && (
        <div
          data-testid="sidebar-backdrop"
          className="fixed inset-0 z-50 bg-black/50 md:hidden"
          onClick={onMobileClose}
        />
      )}

      <div
        className={`
          ${mobileOpen ? "fixed inset-y-0 left-0 z-50 flex w-full max-w-xs flex-col bg-card" : "hidden"}
          md:relative md:flex md:w-60 md:flex-col md:border-r md:border-border md:bg-card
        `}
      >
        <div className="flex h-12 items-center justify-between border-b border-border px-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Conversations
          </span>
          <button
            onClick={onRefresh}
            title="Refresh conversations"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="relative border-b border-border px-3 py-2.5">
          <Search className="absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            type="text"
            placeholder="Search conversations…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-border bg-background py-1.5 pl-7 pr-7 text-sm text-foreground placeholder-muted-foreground/40 transition-shadow focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/10"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              No conversations yet
            </p>
          ) : (
            filtered.map((conversation) => (
              <ConversationRow
                key={conversation.conversationId}
                conversation={conversation}
                isActive={conversation.conversationId === viewConversationId}
                isRunning={runningConversationIds.has(
                  conversation.conversationId,
                )}
                onSelect={() => handleSelect(conversation)}
                onDelete={() => onDeleteConversation(conversation)}
              />
            ))
          )}
        </div>

        <div className="border-t border-border p-2.5">
          <button
            onClick={onNewChat}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 active:scale-[.98]"
          >
            <Plus className="h-4 w-4" />
            New Chat
          </button>
        </div>
      </div>
    </>
  );
}

function ConversationRow({
  conversation,
  isActive,
  isRunning,
  onSelect,
  onDelete,
}: {
  conversation: Conversation;
  isActive: boolean;
  isRunning: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = React.useState(false);
  const title = conversation.title ?? "New chat\u2026";
  const isPending = !conversation.title;

  return (
    <div
      className={`group relative flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm transition-colors duration-100 ${
        isActive
          ? "border-l-2 border-primary bg-primary/8 pl-[10px] text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {isRunning && (
        <span className="flex h-1.5 w-1.5 flex-shrink-0">
          <span className="absolute inline-flex h-1.5 w-1.5 animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
      )}
      <span
        className={`flex-1 truncate leading-snug ${isPending ? "italic opacity-60" : ""}`}
      >
        {title}
      </span>
      {hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="fade-in flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
