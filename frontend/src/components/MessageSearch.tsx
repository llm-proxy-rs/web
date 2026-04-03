import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

interface MessageSearchProps {
  onSearch: (query: string) => void;
  matchCount: number;
  currentMatch: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export default function MessageSearch({
  onSearch,
  matchCount,
  currentMatch,
  onNext,
  onPrev,
  onClose,
}: MessageSearchProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    onSearch(query);
  }, [query, onSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) onPrev();
        else onNext();
      }
    },
    [onClose, onNext, onPrev],
  );

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card/90 px-3 py-1.5 backdrop-blur-sm">
      <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search messages…"
        className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground/40 focus:outline-none"
      />
      {query && (
        <span className="text-xs text-muted-foreground/50">
          {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : "No matches"}
        </span>
      )}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onPrev}
          disabled={matchCount === 0}
          className="rounded p-0.5 text-muted-foreground/50 hover:text-foreground disabled:opacity-30"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={matchCount === 0}
          className="rounded p-0.5 text-muted-foreground/50 hover:text-foreground disabled:opacity-30"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="rounded p-0.5 text-muted-foreground/50 hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
