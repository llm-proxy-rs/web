import { useCallback } from "react";
import type { StoredQuestion } from "../types";
import { safeJsonParse } from "../utils/safeJson";

function isStoredQuestion(v: unknown): v is StoredQuestion {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.conversationId === "string" &&
    typeof obj.taskId === "string" &&
    typeof obj.requestId === "string" &&
    Array.isArray(obj.questions)
  );
}

export function useQuestionStorage() {
  const storeQuestion = useCallback(
    (requestId: string, data: StoredQuestion) => {
      localStorage.setItem(`question_${requestId}`, JSON.stringify(data));
    },
    [],
  );

  const clearQuestion = useCallback((requestId: string) => {
    localStorage.removeItem(`question_${requestId}`);
  }, []);

  const getQuestionsForConversation = useCallback(
    (conversationId: string): StoredQuestion | null => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith("question_")) {
          try {
            const data = safeJsonParse<unknown>(localStorage.getItem(key)!);
            if (
              isStoredQuestion(data) &&
              data.conversationId === conversationId
            ) {
              return data;
            }
          } catch {
            /* ignore */
          }
        }
      }
      return null;
    },
    [],
  );

  return { storeQuestion, clearQuestion, getQuestionsForConversation };
}
