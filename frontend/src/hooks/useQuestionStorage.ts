import { useCallback } from "react";
import type { StoredQuestion } from "../types";

export function useQuestionStorage() {
  const storeQuestion = useCallback((requestId: string, data: StoredQuestion) => {
    localStorage.setItem(`question_${requestId}`, JSON.stringify(data));
  }, []);

  const clearQuestion = useCallback((requestId: string) => {
    localStorage.removeItem(`question_${requestId}`);
  }, []);

  const getQuestionsForConversation = useCallback((conversationId: string): StoredQuestion | null => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("question_")) {
        try {
          const data = JSON.parse(localStorage.getItem(key)!) as StoredQuestion;
          if (data.conversationId === conversationId) {
            return data;
          }
        } catch { /* ignore */ }
      }
    }
    return null;
  }, []);

  return { storeQuestion, clearQuestion, getQuestionsForConversation };
}
