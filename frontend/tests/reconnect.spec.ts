/**
 * RC-01  Reconnect stream opened with saved task_id and conversation_id
 * RC-02  Question panel restored after reconnect
 * RC-03  Done event after reconnect clears running state
 * RC-04  Messages restored from localStorage on reconnect
 * RC-05  Corrupt running-task localStorage ignored — no reconnect stream opened, app loads normally
 * RC-06  Corrupt messages localStorage ignored — reconnect fires but no messages restored
 *
 * These tests use page.addInitScript to pre-set localStorage before the app
 * loads, simulating a previous session that was interrupted. The SseProvider
 * mount effect then sees the saved task_id and opens GET /chat-stream/{taskId}.
 */
import { test, expect } from "@playwright/test";
import { setupApp, VM_ID } from "./helpers/setup";

const TASK_ID = "task-reconnect-test";
const CONV_ID = "conv-reconnect-test";

test.describe("reconnect", () => {
  test("RC-01 reconnect stream opened with saved task_id and conversation_id", async ({ page }) => {
    await page.addInitScript((args: { vmId: string; taskId: string; convId: string }) => {
      localStorage.setItem(
        `chat_running_task_${args.vmId}`,
        JSON.stringify({ task_id: args.taskId, running_session_id: args.convId }),
      );
    }, { vmId: VM_ID, taskId: "task-rc01", convId: "conv-rc01" });

    // Set up waitForRequest before setupApp so it captures the request fired during page load
    const streamReqPromise = page.waitForRequest((r) =>
      r.url().includes("chat-stream/task-rc01") && r.method() === "GET",
    );

    const ctrl = await setupApp(page, {});

    // Deliver done to unblock the route handler and clean up
    ctrl.sendSseEvents([{ event: "done", data: { session_id: null, task_id: "task-rc01" } }]);

    const streamReq = await streamReqPromise;

    // The conversation_id query param should match the stored running_session_id
    const url = new URL(streamReq.url());
    expect(url.searchParams.get("conversation_id")).toBe("conv-rc01");

    await expect(page.getByRole("status")).not.toBeVisible();
  });

  test("RC-02 question panel restored after reconnect", async ({ page }) => {
    await page.addInitScript((args: { vmId: string; taskId: string; convId: string }) => {
      localStorage.setItem(
        `chat_running_task_${args.vmId}`,
        JSON.stringify({ task_id: args.taskId, running_session_id: args.convId }),
      );
    }, { vmId: VM_ID, taskId: "task-rc02", convId: "conv-rc02" });

    const ctrl = await setupApp(page, {});

    ctrl.sendSseEvents([
      {
        event: "ask_user_question",
        data: {
          request_id: "req-rc02",
          task_id: "task-rc02",
          questions: [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }],
        },
      },
    ]);

    await expect(page.getByText("Pick one?")).toBeVisible();

    // Clean up
    ctrl.sendSseEvents([{ event: "done", data: { session_id: null, task_id: "task-rc02" } }]);
  });

  test("RC-03 done event after reconnect clears running state", async ({ page }) => {
    await page.addInitScript((args: { vmId: string; taskId: string; convId: string }) => {
      localStorage.setItem(
        `chat_running_task_${args.vmId}`,
        JSON.stringify({ task_id: args.taskId, running_session_id: args.convId }),
      );
    }, { vmId: VM_ID, taskId: "task-rc03", convId: "conv-rc03" });

    const ctrl = await setupApp(page, {});

    ctrl.sendSseEvents([{ event: "done", data: { session_id: null, task_id: "task-rc03" } }]);

    await expect(page.getByRole("status")).not.toBeVisible();

    // localStorage entry for running task should be cleared
    const storedTask = await page.evaluate(
      (vmId: string) => localStorage.getItem(`chat_running_task_${vmId}`),
      VM_ID,
    );
    expect(storedTask).toBeNull();
  });

  test("RC-04 messages restored from localStorage on reconnect", async ({ page }) => {
    const savedMessages = JSON.stringify([
      { id: "msg-1", type: "user", content: "Hello", timestamp: Date.now() },
      { id: "msg-2", type: "assistant", content: "Prior response", timestamp: Date.now() },
    ]);

    await page.addInitScript(
      (args: { vmId: string; taskId: string; convId: string; messages: string }) => {
        localStorage.setItem(
          `chat_running_task_${args.vmId}`,
          JSON.stringify({ task_id: args.taskId, running_session_id: args.convId }),
        );
        localStorage.setItem(`chat_messages_task_${args.taskId}`, args.messages);
      },
      { vmId: VM_ID, taskId: "task-rc04", convId: "conv-rc04", messages: savedMessages },
    );

    const ctrl = await setupApp(page, {});

    // Messages should already be visible (restored from localStorage via reconnecting event)
    await expect(page.getByText("Prior response")).toBeVisible();

    // Deliver done to clean up
    ctrl.sendSseEvents([{ event: "done", data: { session_id: null, task_id: "task-rc04" } }]);
  });

  test("RC-05 corrupt running-task localStorage is cleared silently, no reconnect stream opened", async ({
    page,
  }) => {
    await page.addInitScript((vmId: string) => {
      localStorage.setItem(`chat_running_task_${vmId}`, "not valid json {{{");
    }, VM_ID);

    let reconnectCalled = false;
    await page.route("**/chat-stream/**", async (route) => {
      reconnectCalled = true;
      await route.fulfill({ status: 200, body: "" });
    });

    await setupApp(page, {});

    // Wait for the corrupt entry to be cleared
    await page.waitForFunction(
      (vmId: string) => localStorage.getItem(`chat_running_task_${vmId}`) === null,
      VM_ID,
    );

    expect(reconnectCalled).toBe(false);
    // Composer still accessible — app has not crashed
    await expect(page.locator('textarea[placeholder="Message Claude…"]')).toBeVisible();
  });

  test("RC-06 corrupt messages localStorage is ignored, reconnect fires without restoring messages", async ({
    page,
  }) => {
    await page.addInitScript(
      (args: { vmId: string; taskId: string; convId: string }) => {
        localStorage.setItem(
          `chat_running_task_${args.vmId}`,
          JSON.stringify({ task_id: args.taskId, running_session_id: args.convId }),
        );
        // Store invalid JSON for the messages key
        localStorage.setItem(`chat_messages_task_${args.taskId}`, "[[broken json");
      },
      { vmId: VM_ID, taskId: "task-rc06", convId: "conv-rc06" },
    );

    const ctrl = await setupApp(page, {});

    // done event clears the running state; if messages parse had crashed the app this would hang
    ctrl.sendSseEvents([{ event: "done", data: { session_id: null, task_id: "task-rc06" } }]);

    // No prior messages restored (parse failed silently)
    await expect(page.getByText("Prior response")).not.toBeVisible();
    // App still functional
    await expect(page.locator('textarea[placeholder="Message Claude…"]')).toBeVisible();
  });
});
