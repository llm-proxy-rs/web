/**
 * Manages a per-conversation running task map in localStorage.
 *
 * Storage key: `chat_running_task_${vmId}`
 * Format: `{ [conversationId]: taskId }`
 *
 * Handles backwards compatibility with the old single-task format:
 * `{ task_id: string, running_session_id: string | null }`
 */

function storageKey(vmId: string): string {
  return `chat_running_task_${vmId}`;
}

export function getRunningTasks(vmId: string): Record<string, string> {
  const raw = localStorage.getItem(storageKey(vmId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    // Backwards compat: old format had { task_id, running_session_id }
    if ("task_id" in parsed && typeof parsed.task_id === "string") {
      const convId = parsed.running_session_id ?? parsed.task_id;
      return { [convId]: parsed.task_id };
    }
    // New format: { [conversationId]: taskId }
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

export function setRunningTask(
  vmId: string,
  conversationId: string,
  taskId: string,
): void {
  const tasks = getRunningTasks(vmId);
  tasks[conversationId] = taskId;
  localStorage.setItem(storageKey(vmId), JSON.stringify(tasks));
}

export function removeRunningTask(vmId: string, conversationId: string): void {
  const tasks = getRunningTasks(vmId);
  delete tasks[conversationId];
  if (Object.keys(tasks).length === 0) {
    localStorage.removeItem(storageKey(vmId));
  } else {
    localStorage.setItem(storageKey(vmId), JSON.stringify(tasks));
  }
}

export function clearRunningTasks(vmId: string): void {
  localStorage.removeItem(storageKey(vmId));
}
