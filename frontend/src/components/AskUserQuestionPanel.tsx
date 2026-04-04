import React, { useState, useCallback, useRef, useEffect } from "react";
import type { PendingQuestion, Question } from "../types";

type RiskLevel = "low" | "medium" | "high";

function classifyRisk(questions: Question[]): RiskLevel {
  const text = questions
    .map((q) => `${q.question} ${q.header ?? ""}`)
    .join(" ")
    .toLowerCase();
  if (
    /\b(bash|shell|sudo|rm\s|rm\b|force|reset\s--hard|drop\s|delete|push\s--force|kill)\b/.test(
      text,
    )
  )
    return "high";
  if (/\b(edit|write|create|modify|install|update|patch|commit)\b/.test(text))
    return "medium";
  return "low";
}

const RISK_STYLES: Record<
  RiskLevel,
  {
    gradient: string;
    badge: string;
    badgeText: string;
    label: string;
    selected: string;
    selectedDesc: string;
    check: string;
    accent: string;
    kbd: string;
    otherBorder: string;
    stepDot: string;
    headerBadge: string;
    submitBtn: string;
  }
> = {
  low: {
    gradient: "from-emerald-500 via-teal-400 to-cyan-400",
    badge:
      "bg-emerald-500/10 text-emerald-500 border-emerald-200 dark:border-emerald-800/50",
    badgeText: "Safe",
    label: "text-emerald-600 dark:text-emerald-400",
    selected:
      "border-emerald-300 bg-emerald-50/80 ring-1 ring-emerald-200/50 dark:border-emerald-600 dark:bg-emerald-900/25",
    selectedDesc: "text-emerald-600/70 dark:text-emerald-300/70",
    check: "text-emerald-500",
    accent: "from-emerald-500/10 to-teal-500/10",
    kbd: "bg-emerald-500",
    otherBorder:
      "border-emerald-300 bg-emerald-50/80 ring-1 ring-emerald-200/50 dark:border-emerald-600 dark:bg-emerald-900/25",
    stepDot: "bg-emerald-500",
    headerBadge:
      "border-emerald-100 bg-emerald-50 text-emerald-600 dark:border-emerald-800/50 dark:bg-emerald-900/30 dark:text-emerald-400",
    submitBtn: "from-emerald-600 to-emerald-500",
  },
  medium: {
    gradient: "from-amber-500 via-yellow-400 to-orange-400",
    badge:
      "bg-amber-500/10 text-amber-500 border-amber-200 dark:border-amber-800/50",
    badgeText: "Review",
    label: "text-amber-600 dark:text-amber-400",
    selected:
      "border-amber-300 bg-amber-50/80 ring-1 ring-amber-200/50 dark:border-amber-600 dark:bg-amber-900/25",
    selectedDesc: "text-amber-600/70 dark:text-amber-300/70",
    check: "text-amber-500",
    accent: "from-amber-500/10 to-yellow-500/10",
    kbd: "bg-amber-500",
    otherBorder:
      "border-amber-300 bg-amber-50/80 ring-1 ring-amber-200/50 dark:border-amber-600 dark:bg-amber-900/25",
    stepDot: "bg-amber-500",
    headerBadge:
      "border-amber-100 bg-amber-50 text-amber-600 dark:border-amber-800/50 dark:bg-amber-900/30 dark:text-amber-400",
    submitBtn: "from-amber-600 to-amber-500",
  },
  high: {
    gradient: "from-red-500 via-rose-400 to-orange-400",
    badge: "bg-red-500/10 text-red-500 border-red-200 dark:border-red-800/50",
    badgeText: "Caution",
    label: "text-red-600 dark:text-red-400",
    selected:
      "border-red-300 bg-red-50/80 ring-1 ring-red-200/50 dark:border-red-600 dark:bg-red-900/25",
    selectedDesc: "text-red-600/70 dark:text-red-300/70",
    check: "text-red-500",
    accent: "from-red-500/10 to-rose-500/10",
    kbd: "bg-red-500",
    otherBorder:
      "border-red-300 bg-red-50/80 ring-1 ring-red-200/50 dark:border-red-600 dark:bg-red-900/25",
    stepDot: "bg-red-500",
    headerBadge:
      "border-red-100 bg-red-50 text-red-600 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-400",
    submitBtn: "from-red-600 to-red-500",
  },
};

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
  const [selections, setSelections] = useState<Map<number, Set<string>>>(
    () => new Map(),
  );
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(
    () => new Map(),
  );
  const [otherActive, setOtherActive] = useState<Map<number, boolean>>(
    () => new Map(),
  );
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

  const toggleOption = useCallback(
    (qIdx: number, label: string, multiSelect: boolean) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const current = new Set(next.get(qIdx) ?? []);
        if (multiSelect) {
          if (current.has(label)) current.delete(label);
          else current.add(label);
        } else {
          current.clear();
          current.add(label);
          setOtherActive((p) => {
            const n = new Map(p);
            n.set(qIdx, false);
            return n;
          });
        }
        next.set(qIdx, current);
        return next;
      });
    },
    [],
  );

  const toggleOther = useCallback((qIdx: number, multiSelect: boolean) => {
    setOtherActive((prev) => {
      const next = new Map(prev);
      const wasActive = next.get(qIdx) ?? false;
      next.set(qIdx, !wasActive);
      if (!multiSelect && !wasActive) {
        setSelections((p) => {
          const n = new Map(p);
          n.set(qIdx, new Set());
          return n;
        });
      }
      return next;
    });
  }, []);

  const setOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTexts((prev) => {
      const next = new Map(prev);
      next.set(qIdx, text);
      return next;
    });
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
      if (e.key === "0") {
        e.preventDefault();
        toggleOther(currentStep, multi);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (currentStep === questions.length - 1) handleSubmit();
        else setCurrentStep((s) => s + 1);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        handleSkip();
        return;
      }
    },
    [
      currentStep,
      questions,
      toggleOption,
      toggleOther,
      handleSubmit,
      handleSkip,
    ],
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
  const risk = classifyRisk(questions);
  const rs = RISK_STYLES[risk];

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
        <div
          className={`absolute left-0 right-0 top-0 h-[2px] bg-gradient-to-r ${rs.gradient}`}
        />

        <div className="px-4 pb-2 pt-3.5">
          <div className="mb-1.5 flex items-center gap-2.5">
            <div className="relative flex-shrink-0">
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br ${rs.accent}`}
              >
                <svg
                  className={`h-3.5 w-3.5 ${rs.label}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.75}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827m0 3h.01"
                  />
                </svg>
              </div>
              <div
                className={`absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full ${risk === "high" ? "bg-red-400" : risk === "medium" ? "bg-amber-400" : "bg-cyan-400"}`}
              />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                Claude needs your input
              </span>
              <span
                className={`inline-flex items-center rounded border px-1.5 py-px text-xs font-semibold uppercase tracking-wider ${rs.badge}`}
              >
                {rs.badgeText}
              </span>
              {q.header && (
                <span
                  className={`inline-flex items-center rounded border px-1.5 py-px text-xs font-semibold uppercase tracking-wider ${rs.headerBadge}`}
                >
                  {q.header}
                </span>
              )}
            </div>
            {!isSingle && (
              <span className="flex-shrink-0 text-xs tabular-nums text-gray-400 dark:text-gray-500">
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
                    i === currentStep
                      ? `w-5 ${rs.stepDot}`
                      : i < currentStep
                        ? `w-2.5 ${rs.stepDot} opacity-50`
                        : "w-2.5 bg-gray-200 dark:bg-gray-700"
                  }`}
                />
              ))}
            </div>
          )}

          <p className="text-sm font-medium leading-snug text-gray-900 dark:text-gray-100">
            {q.question}
          </p>
          {multi && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              Select all that apply
            </span>
          )}
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
                      ? rs.selected
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50/60 dark:border-gray-700/60"
                  }`}
                >
                  <kbd
                    className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded font-mono text-xs transition-all duration-150 ${
                      isSelected
                        ? `${rs.kbd} font-semibold text-white`
                        : "border border-gray-200 bg-gray-100 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500"
                    }`}
                  >
                    {optIdx + 1}
                  </kbd>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-sm leading-tight ${isSelected ? "font-medium text-gray-900 dark:text-gray-100" : "text-gray-700 dark:text-gray-300"}`}
                    >
                      {opt.label}
                    </div>
                    {opt.description && (
                      <div
                        className={`text-xs leading-snug ${isSelected ? rs.selectedDesc : "text-gray-400 dark:text-gray-500"}`}
                      >
                        {opt.description}
                      </div>
                    )}
                  </div>
                  {isSelected && (
                    <svg
                      className={`h-4 w-4 flex-shrink-0 ${rs.check}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      strokeWidth={2.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4.5 12.75l6 6 9-13.5"
                      />
                    </svg>
                  )}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => toggleOther(currentStep, multi)}
              className={`group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-all duration-150 ${
                isOtherOn
                  ? rs.otherBorder
                  : "border-dashed border-gray-200 hover:border-gray-300 hover:bg-gray-50/60 dark:border-gray-700/60"
              }`}
            >
              <kbd
                className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded font-mono text-xs transition-all duration-150 ${
                  isOtherOn
                    ? `${rs.kbd} font-semibold text-white`
                    : "border border-gray-200 bg-gray-100 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500"
                }`}
              >
                0
              </kbd>
              <span
                className={`text-sm leading-tight ${isOtherOn ? "font-medium text-gray-900 dark:text-gray-100" : "text-gray-500 dark:text-gray-400"}`}
              >
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
                  className="w-full rounded-lg border-0 bg-gray-50 px-3 py-1.5 text-sm text-gray-900 outline-none ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-current dark:bg-gray-900/60 dark:text-gray-100 dark:ring-gray-700"
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/50 px-4 py-2 dark:border-gray-700/50 dark:bg-gray-800/50">
          <button
            type="button"
            onClick={handleSkip}
            className="text-xs text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            {isSingle ? "Skip" : "Skip all"}
            <span className="ml-1 text-xs text-gray-300 dark:text-gray-600">
              Esc
            </span>
          </button>

          <div className="flex items-center gap-1.5">
            {!isSingle && !isFirst && (
              <button
                type="button"
                onClick={() => setCurrentStep((s) => s - 1)}
                className="inline-flex items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-all hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700/60"
              >
                Back
              </button>
            )}
            {isLast ? (
              <button
                type="button"
                onClick={handleSubmit}
                className={`inline-flex items-center gap-1 rounded-lg bg-gradient-to-r ${rs.submitBtn} px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:shadow-md`}
              >
                Submit
                <span className="ml-0.5 font-mono text-xs opacity-70">
                  Enter
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setCurrentStep((s) => s + 1)}
                className={`inline-flex items-center gap-1 rounded-lg bg-gradient-to-r ${rs.submitBtn} px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:shadow-md`}
              >
                Next
                <span className="ml-0.5 font-mono text-xs opacity-70">
                  Enter
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
