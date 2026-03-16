import React from "react";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import type { Conversation } from "../types";

interface SidebarProps {
  conversations: Conversation[];
  viewConversationId: string | null;
  runningConversationId: string | null;
  onSelectConversation: (conversation: Conversation) => void;
  onNewChat: () => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onRefresh: () => void;
}

export default function Sidebar({
  conversations,
  viewConversationId,
  runningConversationId,
  onSelectConversation,
  onNewChat,
  onDeleteConversation,
  onRefresh,
}: SidebarProps) {
  return (
    <div className="flex w-60 flex-col border-r border-border bg-card">
      <div className="flex h-11 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Conversations
        </span>
        <button
          onClick={onRefresh}
          title="Refresh conversations"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1.5">
        {conversations.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">No conversations yet</p>
        ) : (
          conversations.map((conversation) => (
            <ConversationRow
              key={conversation.conversationId}
              conversation={conversation}
              isActive={conversation.conversationId === viewConversationId}
              isRunning={conversation.conversationId === runningConversationId}
              onSelect={() => onSelectConversation(conversation)}
              onDelete={() => onDeleteConversation(conversation)}
            />
          ))
        )}
      </div>

      <div className="border-t border-border p-2">
        <button
          onClick={onNewChat}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20 active:scale-[.98]"
        >
          <Plus className="h-4 w-4" />
          New Chat
        </button>
      </div>
    </div>
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
      className={`group relative flex cursor-pointer items-center gap-2 px-3 py-2 text-xs ${
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
      <span className={`flex-1 truncate leading-snug ${isPending ? "italic opacity-60" : ""}`}>
        {title}
      </span>
      {hovered && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
