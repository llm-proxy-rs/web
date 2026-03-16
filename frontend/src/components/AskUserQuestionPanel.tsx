import React, { useState, useCallback, useRef, useEffect } from "react";
import type { PendingQuestion, Question } from "../types";

interface AskUserQuestionPanelProps {
  pendingQuestion: PendingQuestion;
  onSubmit: (requestId: string, answers: Record<string, string>) => void;
  onSkip: (requestId: string) => void;
}

export default function AskUserQuestionPanel({
  pendingQuestion,
  onSubmit,
  onSkip,
}: AskUserQuestionPanelProps) {
  const { requestId, questions } = pendingQuestion;

  const [currentStep, setCurrentStep] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map());
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(() => new Map());
  const [otherActive, setOtherActive] = useState<Map<number, boolean>>(() => new Map());
  const [mounted, setMounted] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
  }, []);

  useEffect(() => {
    if (!otherActive.get(currentStep)) {
      containerRef.current?.focus();
    }
  }, [currentStep, otherActive]);

  useEffect(() => {
    if (otherActive.get(currentStep)) {
      otherInputRef.current?.focus();
    }
  }, [otherActive, currentStep]);

  const toggleOption = useCallback((qIdx: number, label: string, multiSelect: boolean) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(qIdx) ?? []);
      if (multiSelect) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
        setOtherActive((p) => { const n = new Map(p); n.set(qIdx, false); return n; });
      }
      next.set(qIdx, current);
      return next;
    });
  }, []);

  const toggleOther = useCallback((qIdx: number, multiSelect: boolean) => {
    setOtherActive((prev) => {
      const next = new Map(prev);
      const wasActive = next.get(qIdx) ?? false;
      next.set(qIdx, !wasActive);
      if (!multiSelect && !wasActive) {
        setSelections((p) => { const n = new Map(p); n.set(qIdx, new Set()); return n; });
      }
      return next;
    });
  }, []);

  const setOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTexts((prev) => { const next = new Map(prev); next.set(qIdx, text); return next; });
  }, []);

  const buildAnswers = useCallback((): Record<string, string> => {
    const answers: Record<string, string> = {};
    questions.forEach((q, idx) => {
      const selected = Array.from(selections.get(idx) ?? []);
      const isOther = otherActive.get(idx) ?? false;
      const otherText = (otherTexts.get(idx) ?? "").trim();
      if (isOther && otherText) selected.push(otherText);
      if (selected.length > 0) answers[q.question] = selected.join(", ");
    });
    return answers;
  }, [questions, selections, otherActive, otherTexts]);

  const handleSubmit = useCallback(() => {
    onSubmit(requestId, buildAnswers());
  }, [onSubmit, requestId, buildAnswers]);

  const handleSkip = useCallback(() => {
    onSkip(requestId);
  }, [onSkip, requestId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const q = questions[currentStep];
      if (!q) return;
      const multi = q.multiSelect ?? false;
      const optCount = q.options.length;
      const num = parseInt(e.key);
      if (!isNaN(num) && num >= 1 && num <= optCount) {
        e.preventDefault();
        toggleOption(currentStep, q.options[num - 1].label, multi);
        return;
      }
      if (e.key === "0") { e.preventDefault(); toggleOther(currentStep, multi); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        if (currentStep === questions.length - 1) handleSubmit();
        else setCurrentStep((s) => s + 1);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); handleSkip(); return; }
    },
    [currentStep, questions, toggleOption, toggleOther, handleSubmit, handleSkip],
  );

  if (questions.length === 0) return null;

  const total = questions.length;
  const isSingle = total === 1;
  const q = questions[currentStep];
  const multi = q.multiSelect ?? false;
  const selected = selections.get(currentStep) ?? new Set<string>();
  const isOtherOn = otherActive.get(currentStep) ?? false;
  const isLast = currentStep === total - 1;
  const isFirst = currentStep === 0;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={`w-full outline-none transition-all duration-500 ease-out ${
        mounted ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      }`}
    >
      <div className="relative overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-lg dark:border-gray-700/50 dark:bg-gray-800/90">
        <div className="absolute left-0 right-0 top-0 h-[2px] bg-gradient-to-r from-blue-500 via-cyan-400 to-teal-400" />

        <div className="px-4 pb-2 pt-3.5">
          <div className="mb-1.5 flex items-center gap-2.5">
            <div className="relative flex-shrink-0">
              <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/10 to-cyan-500/10">
                <svg className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827m0 3h.01" />
                </svg>
              </div>
              <div className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                Claude needs your input
              </span>
              {q.header && (
                <span className="inline-flex items-center rounded border border-blue-100 bg-blue-50 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-blue-600 dark:border-blue-800/50 dark:bg-blue-900/30 dark:text-blue-400">
                  {q.header}
                </span>
              )}
            </div>
            {!isSingle && (
              <span className="flex-shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-gray-500">
                {currentStep + 1}/{total}
              </span>
            )}
          </div>

          {!isSingle && (
            <div className="mb-2 flex items-center gap-1">
              {questions.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setCurrentStep(i)}
                  className={`h-[3px] rounded-full transition-all duration-300 ${
                    i === currentStep ? "w-5 bg-blue-500" : i < currentStep ? "w-2.5 bg-blue-300" : "w-2.5 bg-gray-200 dark:bg-gray-700"
                  }`}
                />
              ))}
            </div>
          )}

          <p className="text-[14px] font-medium leading-snug text-gray-900 dark:text-gray-100">
            {q.question}
          </p>
          {multi && <span className="text-[10px] text-gray-400 dark:text-gray-500">Select all that apply</span>}
        </div>

        <div className="max-h-48 overflow-y-auto px-4 pb-2">
          <div className="space-y-1">
            {q.options.map((opt, optIdx) => {
              const isSelected = selected.has(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => toggleOption(currentStep, opt.label, multi)}
                  className={`group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-all duration-150 ${
                    isSelected
                      ? "border-blue-300 bg-blue-50/80 ring-1 ring-blue-200/50 dark:border-blue-600 dark:bg-blue-900/25"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50/60 dark:border-gray-700/60"
                  }`}
                >
                  <kbd className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded font-mono text-[10px] transition-all duration-150 ${
                    isSelected ? "bg-blue-500 font-semibold text-white" : "border border-gray-200 bg-gray-100 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500"
                  }`}>
                    {optIdx + 1}
                  </kbd>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[13px] leading-tight ${isSelected ? "font-medium text-gray-900 dark:text-gray-100" : "text-gray-700 dark:text-gray-300"}`}>
                      {opt.label}
                    </div>
                    {opt.description && (
                      <div className={`text-[11px] leading-snug ${isSelected ? "text-blue-600/70 dark:text-blue-300/70" : "text-gray-400 dark:text-gray-500"}`}>
                        {opt.description}
                      </div>
                    )}
                  </div>
                  {isSelected && (
                    <svg className="h-4 w-4 flex-shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  )}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => toggleOther(currentStep, multi)}
              className={`group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-all duration-150 ${
                isOtherOn ? "border-blue-300 bg-blue-50/80 ring-1 ring-blue-200/50 dark:border-blue-600 dark:bg-blue-900/25" : "border-dashed border-gray-200 hover:border-gray-300 hover:bg-gray-50/60 dark:border-gray-700/60"
              }`}
            >
              <kbd className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded font-mono text-[10px] transition-all duration-150 ${
                isOtherOn ? "bg-blue-500 font-semibold text-white" : "border border-gray-200 bg-gray-100 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500"
              }`}>
                0
              </kbd>
              <span className={`text-[13px] leading-tight ${isOtherOn ? "font-medium text-gray-900 dark:text-gray-100" : "text-gray-500 dark:text-gray-400"}`}>
                Other...
              </span>
            </button>

            {isOtherOn && (
              <div className="pl-[30px]">
                <input
                  ref={otherInputRef}
                  type="text"
                  value={otherTexts.get(currentStep) ?? ""}
                  onChange={(e) => setOtherText(currentStep, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (isLast) handleSubmit();
                      else setCurrentStep((s) => s + 1);
                    }
                    e.stopPropagation();
                  }}
                  placeholder="Type your answer..."
                  className="w-full rounded-lg border-0 bg-gray-50 px-3 py-1.5 text-[13px] text-gray-900 outline-none ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-blue-400 dark:bg-gray-900/60 dark:text-gray-100 dark:ring-gray-700"
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/50 px-4 py-2 dark:border-gray-700/50 dark:bg-gray-800/50">
          <button
            type="button"
            onClick={handleSkip}
            className="text-[11px] text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            {isSingle ? "Skip" : "Skip all"}
            <span className="ml-1 text-[9px] text-gray-300 dark:text-gray-600">Esc</span>
          </button>

          <div className="flex items-center gap-1.5">
            {!isSingle && !isFirst && (
              <button
                type="button"
                onClick={() => setCurrentStep((s) => s - 1)}
                className="inline-flex items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-gray-600 transition-all hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700/60"
              >
                Back
              </button>
            )}
            {isLast ? (
              <button
                type="button"
                onClick={handleSubmit}
                className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 px-3.5 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all hover:shadow-md"
              >
                Submit
                <span className="ml-0.5 font-mono text-[9px] opacity-70">Enter</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setCurrentStep((s) => s + 1)}
                className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 px-3.5 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all hover:shadow-md"
              >
                Next
                <span className="ml-0.5 font-mono text-[9px] opacity-70">Enter</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
