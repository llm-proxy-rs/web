"""Tests for agent.py — verifies every function produces SSE events in the
format expected by the frontend (frontend/tests/helpers/setup.ts).

Frontend SSE event shapes:
  session_start    { task_id: string }
  init             {}
  text_delta       { text: string }
  thinking_delta   { thinking: string }
  tool_start       { id: string; name: string; input: object }
  tool_result      { tool_use_id: string; content: string; is_error: boolean }
  ask_user_question{ request_id: string; task_id: string; questions: [...] }
  done             { session_id: string | null; task_id: string }
  error_event      { message: string }
"""

import asyncio
import dataclasses
import importlib.util
import json
import os
import pathlib
import sys
import types
import unittest
import unittest.mock


# ── Load agent module without starting the daemon loop ────────────────────


def _load_agent():
    """Import agent.py but prevent asyncio.run(main()) from executing."""

    async def _noop():
        pass

    with unittest.mock.patch("asyncio.run", side_effect=lambda coro: coro.close()):
        spec = importlib.util.spec_from_file_location(
            "agent",
            pathlib.Path(__file__).parent / "agent.py",
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    return mod


agent = _load_agent()


# ── Mock writer ────────────────────────────────────────────────────────────


class MockWriter:
    """Captures bytes written via writer.write() for assertion."""

    def __init__(self, closing: bool = False):
        self._closing = closing
        self._written: list[bytes] = []

    def is_closing(self) -> bool:
        return self._closing

    def write(self, data: bytes) -> None:
        self._written.append(data)

    async def drain(self) -> None:
        pass

    def written_events(self) -> list[dict]:
        """Parse all captured SSE payloads into {event, data} dicts."""
        events = []
        raw = b"".join(self._written).decode()
        for block in raw.split("\n\n"):
            block = block.strip()
            if not block:
                continue
            event_name = None
            data_str = None
            for line in block.split("\n"):
                if line.startswith("event: "):
                    event_name = line[len("event: ") :]
                elif line.startswith("data: "):
                    data_str = line[len("data: ") :]
            if event_name:
                events.append(
                    {
                        "event": event_name,
                        "data": json.loads(data_str) if data_str else {},
                    }
                )
        return events


# ── Pure utility tests ─────────────────────────────────────────────────────


class TestGetField(unittest.TestCase):
    """get_field retrieves values from both dicts and arbitrary objects."""

    def test_reads_dict_key(self):
        self.assertEqual(agent.get_field({"a": 1}, "a"), 1)

    def test_reads_object_attribute(self):
        class Obj:
            a = 42

        self.assertEqual(agent.get_field(Obj(), "a"), 42)

    def test_dict_missing_key_returns_none_default(self):
        self.assertIsNone(agent.get_field({}, "missing"))

    def test_dict_missing_key_returns_supplied_default(self):
        self.assertEqual(agent.get_field({}, "missing", "fallback"), "fallback")

    def test_object_missing_attribute_returns_none(self):
        self.assertIsNone(agent.get_field(object(), "nope"))

    def test_dict_value_none_returned_correctly(self):
        self.assertIsNone(agent.get_field({"k": None}, "k", "default"))


class TestDefaultHome(unittest.TestCase):
    """_default_home returns the first existing candidate directory."""

    def test_returns_home_ubuntu_when_it_exists(self):
        with unittest.mock.patch(
            "os.path.isdir", side_effect=lambda p: p == "/home/ubuntu"
        ):
            self.assertEqual(agent._default_home(), "/home/ubuntu")

    def test_falls_back_to_root_when_ubuntu_missing(self):
        with unittest.mock.patch("os.path.isdir", side_effect=lambda p: p == "/root"):
            self.assertEqual(agent._default_home(), "/root")

    def test_falls_back_to_root_string_when_neither_exists(self):
        with unittest.mock.patch("os.path.isdir", return_value=False):
            self.assertEqual(agent._default_home(), "/root")


class TestResolveWorkDir(unittest.TestCase):
    """resolve_work_dir validates paths against allowed roots and falls back to HOME."""

    def setUp(self):
        self._home = os.path.realpath(os.environ.get("HOME") or agent._default_home())
        self._tmp = os.path.realpath("/tmp")

    def test_returns_home_fallback_when_raw_is_none(self):
        self.assertEqual(agent.resolve_work_dir(None), self._home)

    def test_returns_home_fallback_when_raw_is_empty_string(self):
        self.assertEqual(agent.resolve_work_dir(""), self._home)

    def test_accepts_tmp_directory(self):
        self.assertEqual(agent.resolve_work_dir("/tmp"), self._tmp)

    def test_accepts_home_directory(self):
        self.assertEqual(agent.resolve_work_dir(self._home), self._home)

    def test_accepts_existing_subdir_of_home(self):
        subdir = os.path.join(self._home, "projects", "resolve_work_dir_test_subdir")
        os.makedirs(subdir, exist_ok=True)
        try:
            self.assertEqual(agent.resolve_work_dir(subdir), subdir)
        finally:
            os.rmdir(subdir)

    def test_rejects_path_outside_allowed_roots(self):
        self.assertEqual(agent.resolve_work_dir("/etc"), self._home)

    def test_rejects_nonexistent_path(self):
        nonexistent = os.path.join(self._tmp, "resolve_work_dir_no_such_dir_xyz")
        self.assertEqual(agent.resolve_work_dir(nonexistent), self._home)

    def test_rejects_path_traversal_attempt(self):
        # Canonicalization prevents escaping an allowed root via ..
        traversal = os.path.join(self._tmp, "..", "etc", "passwd")
        self.assertEqual(agent.resolve_work_dir(traversal), self._home)


class TestClassToEventType(unittest.TestCase):
    """_class_to_event_type derives SSE event names from SDK class names."""

    def test_assistant_message_maps_to_assistant(self):
        class AssistantMessage:
            pass

        self.assertEqual(agent._class_to_event_type(AssistantMessage()), "assistant")

    def test_result_message_maps_to_result(self):
        class ResultMessage:
            pass

        self.assertEqual(agent._class_to_event_type(ResultMessage()), "result")

    def test_system_message_maps_to_system(self):
        class SystemMessage:
            pass

        self.assertEqual(agent._class_to_event_type(SystemMessage()), "system")

    def test_non_message_class_returns_none(self):
        self.assertIsNone(agent._class_to_event_type(object()))


class TestDeriveBlockType(unittest.TestCase):
    """_derive_block_type derives content block type strings from block class names."""

    def test_text_block_maps_to_text(self):
        class TextBlock:
            pass

        self.assertEqual(agent._derive_block_type(TextBlock()), "text")

    def test_tool_use_block_maps_to_tool_use(self):
        class ToolUseBlock:
            pass

        self.assertEqual(agent._derive_block_type(ToolUseBlock()), "tool_use")

    def test_thinking_block_maps_to_thinking(self):
        class ThinkingBlock:
            pass

        self.assertEqual(agent._derive_block_type(ThinkingBlock()), "thinking")

    def test_unknown_block_returns_none(self):
        self.assertIsNone(agent._derive_block_type(object()))


# ── SSE wire-format tests ──────────────────────────────────────────────────


class TestWriteSse(unittest.IsolatedAsyncioTestCase):
    """write_sse serialises events in the SSE wire format the frontend expects."""

    async def test_writes_event_and_data_lines(self):
        writer = MockWriter()
        agent.write_sse(writer, "text_delta", {"text": "hello"})
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "text_delta")
        self.assertEqual(events[0]["data"], {"text": "hello"})

    async def test_skips_write_when_writer_is_closing(self):
        writer = MockWriter(closing=True)
        agent.write_sse(writer, "text_delta", {"text": "hi"})
        self.assertEqual(writer._written, [])

    async def test_empty_data_dict_serialised_correctly(self):
        writer = MockWriter()
        agent.write_sse(writer, "init", {})
        events = writer.written_events()
        self.assertEqual(events[0]["event"], "init")
        self.assertEqual(events[0]["data"], {})

    async def test_tool_start_event_has_required_frontend_fields(self):
        """tool_start data must include id, name, and input fields."""
        writer = MockWriter()
        agent.write_sse(
            writer,
            "tool_start",
            {"id": "t1", "name": "Bash", "input": {"command": "ls"}},
        )
        data = writer.written_events()[0]["data"]
        self.assertIn("id", data)
        self.assertIn("name", data)
        self.assertIn("input", data)

    async def test_tool_result_event_has_required_frontend_fields(self):
        """tool_result data must include tool_use_id, content, and is_error fields."""
        writer = MockWriter()
        agent.write_sse(
            writer,
            "tool_result",
            {"tool_use_id": "t1", "content": "ok", "is_error": False},
        )
        data = writer.written_events()[0]["data"]
        self.assertIn("tool_use_id", data)
        self.assertIn("content", data)
        self.assertIn("is_error", data)

    async def test_session_start_event_has_task_id_field(self):
        """session_start data must include task_id for the frontend to track the session."""
        writer = MockWriter()
        agent.write_sse(writer, "session_start", {"task_id": "abc-123"})
        data = writer.written_events()[0]["data"]
        self.assertEqual(data["task_id"], "abc-123")

    async def test_done_event_has_session_id_and_task_id_fields(self):
        """done data must include session_id and task_id for session resumption."""
        writer = MockWriter()
        agent.write_sse(writer, "done", {"session_id": "s1", "task_id": "t1"})
        data = writer.written_events()[0]["data"]
        self.assertIn("session_id", data)
        self.assertIn("task_id", data)

    async def test_multiple_events_are_all_captured(self):
        writer = MockWriter()
        agent.write_sse(writer, "init", {})
        agent.write_sse(writer, "text_delta", {"text": "part1"})
        agent.write_sse(writer, "text_delta", {"text": "part2"})
        events = writer.written_events()
        self.assertEqual(len(events), 3)
        self.assertEqual(
            [e["event"] for e in events], ["init", "text_delta", "text_delta"]
        )


class TestEmitSse(unittest.IsolatedAsyncioTestCase):
    """emit_sse routes events through the context-var writer with session fallback."""

    async def test_uses_context_var_writer(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.emit_sse("text_delta", {"text": "ctx"})
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "text_delta")
        self.assertEqual(events[0]["data"]["text"], "ctx")

    async def test_falls_back_to_session_writer_when_context_writer_is_closing(self):
        closed_writer = MockWriter(closing=True)
        fallback_writer = MockWriter()
        task_id = "fallback-task"
        task = asyncio.create_task(asyncio.sleep(0))
        agent._sessions[task_id] = agent.Session(
            task=task, writer=fallback_writer, conversation_id=""
        )
        token1 = agent._emit_writer.set(closed_writer)
        token2 = agent._emit_session_id.set(task_id)
        try:
            agent.emit_sse("text_delta", {"text": "fallback"})
        finally:
            agent._emit_writer.reset(token1)
            agent._emit_session_id.reset(token2)
            agent._sessions.pop(task_id, None)
        events = fallback_writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "text_delta")

    async def test_falls_back_to_session_writer_when_context_writer_is_none(self):
        fallback_writer = MockWriter()
        task_id = "none-writer-task"
        task = asyncio.create_task(asyncio.sleep(0))
        agent._sessions[task_id] = agent.Session(
            task=task, writer=fallback_writer, conversation_id=""
        )
        token1 = agent._emit_writer.set(None)
        token2 = agent._emit_session_id.set(task_id)
        try:
            agent.emit_sse("init", {})
        finally:
            agent._emit_writer.reset(token1)
            agent._emit_session_id.reset(token2)
            agent._sessions.pop(task_id, None)
        self.assertEqual(fallback_writer.written_events()[0]["event"], "init")

    async def test_does_nothing_when_no_writer_available(self):
        token1 = agent._emit_writer.set(None)
        token2 = agent._emit_session_id.set(None)
        try:
            agent.emit_sse("text_delta", {"text": "ghost"})
        finally:
            agent._emit_writer.reset(token1)
            agent._emit_session_id.reset(token2)
        # Should not raise; nothing to assert beyond no exception


# ── Connection handler tests ───────────────────────────────────────────────


class TestHandleHello(unittest.IsolatedAsyncioTestCase):
    """handle_hello rebinds a reconnecting client to its session."""

    async def test_rebinds_new_writer_to_existing_session(self):
        task = asyncio.create_task(asyncio.sleep(0))
        old_writer = MockWriter()
        new_writer = MockWriter()
        task_id = "hello-task"
        agent._sessions[task_id] = agent.Session(
            task=task, writer=old_writer, conversation_id=""
        )
        try:
            agent.handle_hello({"type": "hello", "task_id": task_id}, new_writer)
            self.assertIs(agent._sessions[task_id].writer, new_writer)
        finally:
            agent._sessions.pop(task_id, None)

    async def test_re_emits_pending_ask_user_question_on_reconnect(self):
        """The frontend expects ask_user_question re-sent on reconnect so the
        user does not miss an unanswered question prompt."""
        task = asyncio.create_task(asyncio.sleep(0))
        new_writer = MockWriter()
        task_id = "hello-q-task"
        question_data = {
            "request_id": "req-1",
            "task_id": task_id,
            "questions": [
                {"question": "Pick?", "header": "Choice", "options": [{"label": "A"}]}
            ],
        }
        agent._sessions[task_id] = agent.Session(
            task=task,
            writer=MockWriter(),
            conversation_id="",
            pending_question=asyncio.get_running_loop().create_future(),
            pending_question_data=question_data,
        )
        try:
            agent.handle_hello({"type": "hello", "task_id": task_id}, new_writer)
            events = new_writer.written_events()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["event"], "ask_user_question")
            data = events[0]["data"]
            self.assertEqual(data["request_id"], "req-1")
            self.assertIn("questions", data)
        finally:
            agent._sessions.pop(task_id, None)

    async def test_no_re_emission_when_no_pending_question(self):
        task = asyncio.create_task(asyncio.sleep(0))
        writer = MockWriter()
        task_id = "hello-nq-task"
        agent._sessions[task_id] = agent.Session(
            task=task, writer=MockWriter(), conversation_id=""
        )
        try:
            agent.handle_hello({"type": "hello", "task_id": task_id}, writer)
            self.assertEqual(writer.written_events(), [])
        finally:
            agent._sessions.pop(task_id, None)

    async def test_emits_done_for_unknown_task_id(self):
        writer = MockWriter()
        agent.handle_hello({"type": "hello", "task_id": "nonexistent"}, writer)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "done")
        self.assertEqual(events[0]["data"]["task_id"], "nonexistent")
        self.assertIsNone(events[0]["data"]["session_id"])

    async def test_missing_task_id_is_no_op(self):
        writer = MockWriter()
        agent.handle_hello({"type": "hello"}, writer)


class TestHandleAnswerQuestion(unittest.IsolatedAsyncioTestCase):
    """handle_answer_question delivers answers to the waiting session future."""

    async def test_resolves_pending_future_with_answers(self):
        task = asyncio.create_task(asyncio.sleep(0))
        future = asyncio.get_running_loop().create_future()
        task_id = "ans-task"
        agent._sessions[task_id] = agent.Session(
            task=task,
            writer=MockWriter(),
            conversation_id="",
            pending_question=future,
            pending_question_data={"request_id": "req-x"},
        )
        try:
            agent.handle_answer_question(
                {
                    "type": "answer_question",
                    "request_id": "req-x",
                    "answers": {"Q": "A"},
                }
            )
            self.assertTrue(future.done())
            self.assertEqual(future.result(), {"Q": "A"})
        finally:
            agent._sessions.pop(task_id, None)

    async def test_empty_answers_dict_resolves_future(self):
        task = asyncio.create_task(asyncio.sleep(0))
        future = asyncio.get_running_loop().create_future()
        task_id = "ans-empty-task"
        agent._sessions[task_id] = agent.Session(
            task=task,
            writer=MockWriter(),
            conversation_id="",
            pending_question=future,
            pending_question_data={"request_id": "req-y"},
        )
        try:
            agent.handle_answer_question(
                {"type": "answer_question", "request_id": "req-y"}
            )
            self.assertTrue(future.done())
            self.assertEqual(future.result(), {})
        finally:
            agent._sessions.pop(task_id, None)

    async def test_ignores_unknown_request_id(self):
        agent.handle_answer_question(
            {"type": "answer_question", "request_id": "nobody"}
        )


class TestHandleInterrupt(unittest.IsolatedAsyncioTestCase):
    """handle_interrupt cancels the task for the identified session."""

    async def test_cancels_task(self):
        async def long_running():
            await asyncio.sleep(999)

        task = asyncio.create_task(long_running())
        writer = MockWriter()
        task_id = "intr-task"
        agent._sessions[task_id] = agent.Session(
            task=task, writer=writer, conversation_id=""
        )
        try:
            agent.handle_interrupt({"type": "interrupt", "task_id": task_id})
            self.assertGreater(task.cancelling(), 0)
        finally:
            agent._sessions.pop(task_id, None)
            task.cancel()

    async def test_cancels_even_when_writer_does_not_match(self):
        """Interrupts arrive on a different SSH connection (different writer),
        so handle_interrupt must NOT require writer identity."""

        async def long_running():
            await asyncio.sleep(999)

        task = asyncio.create_task(long_running())
        session_writer = MockWriter()
        task_id = "intr-mismatch"
        agent._sessions[task_id] = agent.Session(
            task=task, writer=session_writer, conversation_id=""
        )
        try:
            agent.handle_interrupt({"type": "interrupt", "task_id": task_id})
            self.assertGreater(task.cancelling(), 0)
            self.assertTrue(agent._sessions[task_id].cancelled)
        finally:
            agent._sessions.pop(task_id, None)
            task.cancel()

    async def test_does_not_cancel_already_done_task(self):
        task = asyncio.create_task(asyncio.sleep(0))
        await task  # ensure it completes before the interrupt arrives
        writer = MockWriter()
        task_id = "intr-done-task"
        agent._sessions[task_id] = agent.Session(
            task=task, writer=writer, conversation_id=""
        )
        try:
            agent.handle_interrupt({"type": "interrupt", "task_id": task_id})
            self.assertTrue(task.done())
            self.assertFalse(task.cancelled())
        finally:
            agent._sessions.pop(task_id, None)

    async def test_ignores_unknown_task_id(self):
        agent.handle_interrupt({"type": "interrupt", "task_id": "ghost"})

    async def test_missing_task_id_is_no_op(self):
        agent.handle_interrupt({"type": "interrupt"})

    async def test_sets_cancelled_flag_on_session(self):
        """handle_interrupt should set session.cancelled = True."""

        async def long_running():
            await asyncio.sleep(999)

        task = asyncio.create_task(long_running())
        writer = MockWriter()
        task_id = "intr-cancel-flag"
        agent._sessions[task_id] = agent.Session(
            task=task, writer=writer, conversation_id=""
        )
        try:
            self.assertFalse(agent._sessions[task_id].cancelled)
            agent.handle_interrupt({"type": "interrupt", "task_id": task_id})
            self.assertTrue(agent._sessions[task_id].cancelled)
        finally:
            agent._sessions.pop(task_id, None)
            task.cancel()

    async def test_cancelled_flag_set_even_when_writer_does_not_match(self):
        """cancelled flag should be set regardless of writer identity."""

        async def long_running():
            await asyncio.sleep(999)

        task = asyncio.create_task(long_running())
        session_writer = MockWriter()
        task_id = "intr-cancel-mismatch"
        agent._sessions[task_id] = agent.Session(
            task=task, writer=session_writer, conversation_id=""
        )
        try:
            agent.handle_interrupt({"type": "interrupt", "task_id": task_id})
            self.assertTrue(agent._sessions[task_id].cancelled)
        finally:
            agent._sessions.pop(task_id, None)
            task.cancel()


class TestEmitSseCancelledSuppression(unittest.IsolatedAsyncioTestCase):
    """emit_sse suppresses events (except done/error_event) when session is cancelled."""

    async def _setup_cancelled_session(self):
        """Helper: create a cancelled session and set context vars."""
        writer = MockWriter()
        task_id = "cancel-suppress"
        task = asyncio.create_task(asyncio.sleep(999))
        session = agent.Session(
            task=task, writer=writer, conversation_id="", cancelled=True
        )
        agent._sessions[task_id] = session
        token1 = agent._emit_writer.set(writer)
        token2 = agent._emit_session_id.set(task_id)
        return writer, task_id, task, token1, token2

    async def _cleanup(self, task_id, task, token1, token2):
        agent._emit_writer.reset(token1)
        agent._emit_session_id.reset(token2)
        agent._sessions.pop(task_id, None)
        task.cancel()

    async def test_text_delta_suppressed_when_cancelled(self):
        writer, task_id, task, t1, t2 = await self._setup_cancelled_session()
        try:
            agent.emit_sse("text_delta", {"text": "should not appear"})
            self.assertEqual(len(writer.written_events()), 0)
        finally:
            await self._cleanup(task_id, task, t1, t2)

    async def test_thinking_delta_suppressed_when_cancelled(self):
        writer, task_id, task, t1, t2 = await self._setup_cancelled_session()
        try:
            agent.emit_sse("thinking_delta", {"thinking": "nope"})
            self.assertEqual(len(writer.written_events()), 0)
        finally:
            await self._cleanup(task_id, task, t1, t2)

    async def test_init_suppressed_when_cancelled(self):
        writer, task_id, task, t1, t2 = await self._setup_cancelled_session()
        try:
            agent.emit_sse("init", {})
            self.assertEqual(len(writer.written_events()), 0)
        finally:
            await self._cleanup(task_id, task, t1, t2)

    async def test_tool_start_suppressed_when_cancelled(self):
        writer, task_id, task, t1, t2 = await self._setup_cancelled_session()
        try:
            agent.emit_sse("tool_start", {"id": "t1", "name": "Read", "input": {}})
            self.assertEqual(len(writer.written_events()), 0)
        finally:
            await self._cleanup(task_id, task, t1, t2)

    async def test_done_still_emitted_when_cancelled(self):
        writer, task_id, task, t1, t2 = await self._setup_cancelled_session()
        try:
            agent.emit_sse("done", {"session_id": None, "task_id": task_id})
            events = writer.written_events()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["event"], "done")
        finally:
            await self._cleanup(task_id, task, t1, t2)

    async def test_error_event_still_emitted_when_cancelled(self):
        writer, task_id, task, t1, t2 = await self._setup_cancelled_session()
        try:
            agent.emit_sse("error_event", {"message": "err"})
            events = writer.written_events()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["event"], "error_event")
        finally:
            await self._cleanup(task_id, task, t1, t2)

    async def test_non_cancelled_session_emits_normally(self):
        """Events should pass through when session.cancelled is False."""
        writer = MockWriter()
        task_id = "cancel-not-set"
        task = asyncio.create_task(asyncio.sleep(999))
        agent._sessions[task_id] = agent.Session(
            task=task, writer=writer, conversation_id="", cancelled=False
        )
        token1 = agent._emit_writer.set(writer)
        token2 = agent._emit_session_id.set(task_id)
        try:
            agent.emit_sse("text_delta", {"text": "hello"})
            events = writer.written_events()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["data"]["text"], "hello")
        finally:
            agent._emit_writer.reset(token1)
            agent._emit_session_id.reset(token2)
            agent._sessions.pop(task_id, None)
            task.cancel()

    async def test_multiple_events_all_suppressed_except_done(self):
        """Simulate a burst of events after cancel — only done should get through."""
        writer, task_id, task, t1, t2 = await self._setup_cancelled_session()
        try:
            agent.emit_sse("text_delta", {"text": "a"})
            agent.emit_sse("text_delta", {"text": "b"})
            agent.emit_sse("tool_start", {"id": "t1", "name": "X", "input": {}})
            agent.emit_sse("done", {"session_id": None, "task_id": task_id})
            events = writer.written_events()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["event"], "done")
        finally:
            await self._cleanup(task_id, task, t1, t2)


class TestHandleQuery(unittest.IsolatedAsyncioTestCase):
    """handle_query creates a session and spawns a task for the query."""

    async def _handle_query_with_mock(self, writer, content="hi", session_id=None):
        async def fake_run_query(*args, **kwargs):
            pass

        with unittest.mock.patch.object(agent, "run_query", side_effect=fake_run_query):
            agent.handle_query(
                {"type": "query", "content": content, "session_id": session_id}, writer
            )

    async def test_creates_new_session_in_registry(self):
        writer = MockWriter()
        initial_count = len(agent._sessions)
        await self._handle_query_with_mock(writer)
        self.assertEqual(len(agent._sessions), initial_count + 1)
        for tid, sess in list(agent._sessions.items()):
            if sess.writer is writer:
                agent._sessions.pop(tid)
                break

    async def test_session_stores_correct_writer(self):
        writer = MockWriter()
        await self._handle_query_with_mock(writer)
        found = False
        for tid, sess in list(agent._sessions.items()):
            if sess.writer is writer:
                self.assertIs(sess.writer, writer)
                agent._sessions.pop(tid)
                found = True
                break
        self.assertTrue(found, "no session found with the expected writer")

    async def test_session_has_running_task(self):
        writer = MockWriter()
        await self._handle_query_with_mock(writer)
        for tid, sess in list(agent._sessions.items()):
            if sess.writer is writer:
                self.assertIsNotNone(sess.task)
                agent._sessions.pop(tid)
                break

    async def test_handle_query_uses_client_task_id(self):
        writer = MockWriter()
        captured_args = []

        async def fake_run_query(*args, **kwargs):
            captured_args.extend(args)

        with unittest.mock.patch.object(agent, "run_query", side_effect=fake_run_query):
            agent.handle_query(
                {"type": "query", "content": "hi", "task_id": "custom-id"}, writer
            )
        try:
            self.assertIn("custom-id", agent._sessions)
        finally:
            agent._sessions.pop("custom-id", None)

    async def test_handle_query_passes_work_dir_to_run_query(self):
        writer = MockWriter()
        captured_args = []

        async def fake_run_query(*args, **kwargs):
            captured_args.extend(args)

        with unittest.mock.patch.object(agent, "run_query", side_effect=fake_run_query):
            agent.handle_query(
                {
                    "type": "query",
                    "content": "hi",
                    "task_id": "wd-task",
                    "work_dir": "/tmp",
                },
                writer,
            )
            await asyncio.sleep(0)  # allow the created task to execute
        # run_query(content, sdk_session_id, task_id, conversation_id, work_dir)
        # resolve_work_dir returns os.path.realpath("/tmp") which may differ on macOS
        self.assertEqual(captured_args[4], os.path.realpath("/tmp"))
        agent._sessions.pop("wd-task", None)

    async def test_handle_query_rejects_work_dir_outside_allowed_roots(self):
        writer = MockWriter()
        captured_args = []

        async def fake_run_query(*args, **kwargs):
            captured_args.extend(args)

        with unittest.mock.patch.object(agent, "run_query", side_effect=fake_run_query):
            agent.handle_query(
                {
                    "type": "query",
                    "content": "hi",
                    "task_id": "wd-reject",
                    "work_dir": "/etc",
                },
                writer,
            )
            await asyncio.sleep(0)
        # /etc is outside allowed roots — should fall back to HOME (realpath'd)
        fallback = os.path.realpath(os.environ.get("HOME", "/root"))
        self.assertEqual(captured_args[4], fallback)
        agent._sessions.pop("wd-reject", None)

    async def test_handle_query_accepts_subdir_of_allowed_root(self):
        writer = MockWriter()
        captured_args = []
        home = os.path.realpath(os.environ.get("HOME", "/root"))
        subdir = os.path.join(home, "projects", "myapp")
        os.makedirs(subdir, exist_ok=True)

        async def fake_run_query(*args, **kwargs):
            captured_args.extend(args)

        with unittest.mock.patch.object(agent, "run_query", side_effect=fake_run_query):
            agent.handle_query(
                {
                    "type": "query",
                    "content": "hi",
                    "task_id": "wd-sub",
                    "work_dir": subdir,
                },
                writer,
            )
            await asyncio.sleep(0)
        self.assertEqual(captured_args[4], subdir)
        agent._sessions.pop("wd-sub", None)


class TestHandleQueryDuplicateTaskId(unittest.IsolatedAsyncioTestCase):
    """handle_query cancels the old session when a duplicate task_id arrives."""

    async def test_duplicate_task_id_cancels_previous_task(self):
        async def long_running():
            await asyncio.sleep(999)

        old_task = asyncio.create_task(long_running())
        old_writer = MockWriter()
        task_id = "dup-task"
        agent._sessions[task_id] = agent.Session(
            task=old_task, writer=old_writer, conversation_id=""
        )

        new_writer = MockWriter()

        async def fake_run_query(*args, **kwargs):
            pass

        with unittest.mock.patch.object(agent, "run_query", side_effect=fake_run_query):
            agent.handle_query(
                {"type": "query", "content": "hi", "task_id": task_id}, new_writer
            )

        try:
            # Old task should be cancelled
            self.assertGreater(old_task.cancelling(), 0)
            # New session should be registered with the new writer
            self.assertIn(task_id, agent._sessions)
            self.assertIs(agent._sessions[task_id].writer, new_writer)
        finally:
            agent._sessions.pop(task_id, None)
            old_task.cancel()

    async def test_duplicate_task_id_sets_cancelled_flag_on_old_session(self):
        async def long_running():
            await asyncio.sleep(999)

        old_task = asyncio.create_task(long_running())
        old_writer = MockWriter()
        task_id = "dup-flag"
        old_session = agent.Session(
            task=old_task, writer=old_writer, conversation_id=""
        )
        agent._sessions[task_id] = old_session

        new_writer = MockWriter()

        async def fake_run_query(*args, **kwargs):
            pass

        with unittest.mock.patch.object(agent, "run_query", side_effect=fake_run_query):
            agent.handle_query(
                {"type": "query", "content": "hi", "task_id": task_id}, new_writer
            )

        try:
            self.assertTrue(old_session.cancelled)
        finally:
            agent._sessions.pop(task_id, None)
            old_task.cancel()

    async def test_duplicate_task_id_with_done_task_does_not_error(self):
        """If the old task already completed, handle_query should still succeed."""
        done_task = asyncio.create_task(asyncio.sleep(0))
        await done_task
        old_writer = MockWriter()
        task_id = "dup-done"
        agent._sessions[task_id] = agent.Session(
            task=done_task, writer=old_writer, conversation_id=""
        )

        new_writer = MockWriter()

        async def fake_run_query(*args, **kwargs):
            pass

        with unittest.mock.patch.object(agent, "run_query", side_effect=fake_run_query):
            agent.handle_query(
                {"type": "query", "content": "hi", "task_id": task_id}, new_writer
            )

        try:
            self.assertIn(task_id, agent._sessions)
            self.assertIs(agent._sessions[task_id].writer, new_writer)
        finally:
            agent._sessions.pop(task_id, None)


# ── Stream event processing tests ─────────────────────────────────────────


class TestProcessBlockStart(unittest.IsolatedAsyncioTestCase):
    """process_block_start records per-block state and emits init for text blocks."""

    async def test_text_block_emits_init_event_and_returns_true(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            ev = {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text"},
            }
            result = agent.process_block_start(ev, {}, {}, {})
        finally:
            agent._emit_writer.reset(token)
        self.assertTrue(result)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "init")

    async def test_tool_use_block_records_tool_info_and_returns_false(self):
        ev = {
            "type": "content_block_start",
            "index": 1,
            "content_block": {"type": "tool_use", "id": "t1", "name": "Bash"},
        }
        block_types: dict = {}
        tool_info: dict = {}
        tool_input: dict = {}
        result = agent.process_block_start(ev, block_types, tool_info, tool_input)
        self.assertFalse(result)
        self.assertEqual(block_types[1], "tool_use")
        self.assertEqual(tool_info[1], {"id": "t1", "name": "Bash"})
        self.assertEqual(tool_input[1], "")

    async def test_tool_use_block_does_not_emit_any_sse(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            ev = {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "t1", "name": "Read"},
            }
            agent.process_block_start(ev, {}, {}, {})
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])

    async def test_records_block_type_for_text_block(self):
        ev = {
            "type": "content_block_start",
            "index": 2,
            "content_block": {"type": "text"},
        }
        block_types: dict = {}
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.process_block_start(ev, block_types, {}, {})
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(block_types[2], "text")


class TestProcessBlockDelta(unittest.IsolatedAsyncioTestCase):
    """process_block_delta emits the correct SSE event per delta type."""

    async def test_text_delta_emits_text_delta_event_with_text_field(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            ev = {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Hello"},
            }
            result = agent.process_block_delta(ev, {0: "text"}, {}, {})
        finally:
            agent._emit_writer.reset(token)
        self.assertTrue(result)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "text_delta")
        self.assertEqual(events[0]["data"]["text"], "Hello")

    async def test_thinking_delta_emits_thinking_delta_event_with_thinking_field(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            ev = {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "Hmm…"},
            }
            agent.process_block_delta(ev, {0: "thinking"}, {}, {})
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "thinking_delta")
        self.assertEqual(events[0]["data"]["thinking"], "Hmm…")

    async def test_input_json_delta_accumulates_without_emitting(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        tool_input: dict = {0: ""}
        try:
            for chunk in ['{"command"', ': "ls"}']:
                ev = {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": chunk},
                }
                agent.process_block_delta(
                    ev, {0: "tool_use"}, {0: {"id": "t1", "name": "Bash"}}, tool_input
                )
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])
        self.assertEqual(tool_input[0], '{"command": "ls"}')

    async def test_empty_text_delta_does_not_emit_and_returns_false(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            ev = {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": ""},
            }
            result = agent.process_block_delta(ev, {0: "text"}, {}, {})
        finally:
            agent._emit_writer.reset(token)
        self.assertFalse(result)
        self.assertEqual(writer.written_events(), [])

    async def test_empty_thinking_delta_does_not_emit(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            ev = {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": ""},
            }
            agent.process_block_delta(ev, {0: "thinking"}, {}, {})
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])


class TestProcessBlockStop(unittest.IsolatedAsyncioTestCase):
    """process_block_stop emits tool_start and cleans up tracking state."""

    async def test_emits_tool_start_with_parsed_input_for_non_ask_user_question(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        block_types = {0: "tool_use"}
        tool_info = {0: {"id": "t1", "name": "Bash"}}
        tool_input = {0: '{"command": "ls"}'}
        try:
            agent.process_block_stop(
                {"type": "content_block_stop", "index": 0},
                block_types,
                tool_info,
                tool_input,
            )
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "tool_start")
        data = events[0]["data"]
        self.assertEqual(data["id"], "t1")
        self.assertEqual(data["name"], "Bash")
        self.assertEqual(data["input"], {"command": "ls"})

    async def test_skips_tool_start_for_ask_user_question(self):
        """AskUserQuestion is handled by the hook — no tool_start emitted."""
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        block_types = {0: "tool_use"}
        tool_info = {0: {"id": "q1", "name": "AskUserQuestion"}}
        tool_input = {0: '{"questions": []}'}
        try:
            agent.process_block_stop(
                {"type": "content_block_stop", "index": 0},
                block_types,
                tool_info,
                tool_input,
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])

    async def test_cleans_up_tracking_dicts_after_tool_stop(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        block_types = {0: "tool_use"}
        tool_info = {0: {"id": "t2", "name": "Read"}}
        tool_input = {0: "{}"}
        try:
            agent.process_block_stop(
                {"type": "content_block_stop", "index": 0},
                block_types,
                tool_info,
                tool_input,
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertNotIn(0, block_types)
        self.assertNotIn(0, tool_info)
        self.assertNotIn(0, tool_input)

    async def test_cleans_up_block_types_for_text_block(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        block_types = {0: "text"}
        try:
            agent.process_block_stop(
                {"type": "content_block_stop", "index": 0}, block_types, {}, {}
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertNotIn(0, block_types)

    async def test_invalid_json_in_tool_input_falls_back_to_empty_dict(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        block_types = {0: "tool_use"}
        tool_info = {0: {"id": "t3", "name": "Bash"}}
        tool_input = {0: "not-valid-json"}
        try:
            agent.process_block_stop(
                {"type": "content_block_stop", "index": 0},
                block_types,
                tool_info,
                tool_input,
            )
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(events[0]["data"]["input"], {})


class TestProcessStreamEvent(unittest.IsolatedAsyncioTestCase):
    """process_stream_event dispatches to the correct sub-handler by event type."""

    def _make_event(self, inner: dict):
        ev = unittest.mock.MagicMock()
        ev.event = inner
        return ev

    async def test_content_block_start_for_text_returns_true(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            result = agent.process_stream_event(
                self._make_event(
                    {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "text"},
                    }
                ),
                {},
                {},
                {},
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertTrue(result)

    async def test_content_block_delta_for_text_delta_returns_true(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            result = agent.process_stream_event(
                self._make_event(
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": "hi"},
                    }
                ),
                {0: "text"},
                {},
                {0: ""},
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertTrue(result)

    async def test_content_block_stop_returns_false(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            result = agent.process_stream_event(
                self._make_event({"type": "content_block_stop", "index": 0}),
                {},
                {},
                {},
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertFalse(result)

    async def test_message_start_returns_false(self):
        result = agent.process_stream_event(
            self._make_event({"type": "message_start"}), {}, {}, {}
        )
        self.assertFalse(result)

    async def test_message_delta_returns_false(self):
        result = agent.process_stream_event(
            self._make_event({"type": "message_delta"}), {}, {}, {}
        )
        self.assertFalse(result)

    async def test_message_stop_returns_false(self):
        result = agent.process_stream_event(
            self._make_event({"type": "message_stop"}), {}, {}, {}
        )
        self.assertFalse(result)

    async def test_ping_returns_false(self):
        result = agent.process_stream_event(
            self._make_event({"type": "ping"}), {}, {}, {}
        )
        self.assertFalse(result)


# ── Structured agent event processing tests ────────────────────────────────


class TestEmitAssistantBlock(unittest.IsolatedAsyncioTestCase):
    """emit_assistant_block emits the correct SSE event for each block type."""

    def _make_block(self, type_: str, **kwargs):
        class Block:
            pass

        b = Block()
        b.type = type_
        for k, v in kwargs.items():
            setattr(b, k, v)
        return b

    async def test_text_block_emits_init_then_text_delta(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.emit_assistant_block(self._make_block("text", text="hello"))
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        names = [e["event"] for e in events]
        self.assertIn("init", names)
        self.assertIn("text_delta", names)
        self.assertEqual(events[names.index("text_delta")]["data"]["text"], "hello")

    async def test_empty_text_block_emits_nothing(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.emit_assistant_block(self._make_block("text", text=""))
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])

    async def test_thinking_block_emits_thinking_delta(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.emit_assistant_block(
                self._make_block("thinking", thinking="deep thought")
            )
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "thinking_delta")
        self.assertEqual(events[0]["data"]["thinking"], "deep thought")

    async def test_tool_use_block_emits_tool_start(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.emit_assistant_block(
                self._make_block(
                    "tool_use", id="t1", name="Bash", input={"command": "ls"}
                )
            )
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "tool_start")
        self.assertEqual(events[0]["data"]["name"], "Bash")

    async def test_ask_user_question_block_emits_nothing(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.emit_assistant_block(
                self._make_block("tool_use", id="q1", name="AskUserQuestion", input={})
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])


class TestEmitToolResultBlock(unittest.IsolatedAsyncioTestCase):
    """emit_tool_result_block emits a single tool_result SSE event."""

    def _make_block(self, tool_use_id, content, is_error=False):
        class Block:
            type = "tool_result"

        b = Block()
        b.tool_use_id = tool_use_id
        b.content = content
        b.is_error = is_error
        return b

    async def test_emits_tool_result_with_string_content(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.emit_tool_result_block(self._make_block("t1", "output text"))
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "tool_result")
        self.assertEqual(events[0]["data"]["tool_use_id"], "t1")
        self.assertEqual(events[0]["data"]["content"], "output text")
        self.assertFalse(events[0]["data"]["is_error"])

    async def test_emits_tool_result_joining_list_content(self):
        class TextBlock:
            type = "text"
            text = "line one"

        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.emit_tool_result_block(self._make_block("t2", [TextBlock()]))
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events()[0]["data"]["content"], "line one")

    async def test_is_error_propagated(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.emit_tool_result_block(
                self._make_block("err1", "failed", is_error=True)
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertTrue(writer.written_events()[0]["data"]["is_error"])


class TestProcessAssistantEvent(unittest.IsolatedAsyncioTestCase):
    """process_assistant_event emits the full message when streaming did not."""

    def _make_block(self, type_: str, **kwargs):
        class Block:
            pass

        b = Block()
        b.type = type_
        for k, v in kwargs.items():
            setattr(b, k, v)
        return b

    def _make_event(self, blocks):
        ev = unittest.mock.MagicMock()
        ev.content = blocks
        ev.message = None
        return ev

    async def test_skips_all_emission_when_streaming_text_already_sent(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.process_assistant_event(
                self._make_event([self._make_block("text", text="hello")]),
                emitted_streaming_text=True,
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])

    async def test_emits_init_then_text_delta_for_text_block(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.process_assistant_event(
                self._make_event([self._make_block("text", text="The answer is 42.")]),
                emitted_streaming_text=False,
            )
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        names = [e["event"] for e in events]
        self.assertIn("init", names)
        self.assertIn("text_delta", names)
        self.assertLess(names.index("init"), names.index("text_delta"))
        text_event = next(e for e in events if e["event"] == "text_delta")
        self.assertEqual(text_event["data"]["text"], "The answer is 42.")

    async def test_emits_thinking_delta_for_thinking_block(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.process_assistant_event(
                self._make_event([self._make_block("thinking", thinking="I reason…")]),
                emitted_streaming_text=False,
            )
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "thinking_delta")
        self.assertEqual(events[0]["data"]["thinking"], "I reason…")

    async def test_emits_tool_start_for_tool_use_block(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            block = self._make_block(
                "tool_use", id="t1", name="Bash", input={"command": "ls"}
            )
            agent.process_assistant_event(
                self._make_event([block]),
                emitted_streaming_text=False,
            )
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "tool_start")
        data = events[0]["data"]
        self.assertEqual(data["id"], "t1")
        self.assertEqual(data["name"], "Bash")
        self.assertEqual(data["input"], {"command": "ls"})

    async def test_skips_ask_user_question_tool_block(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            block = self._make_block(
                "tool_use", id="q1", name="AskUserQuestion", input={}
            )
            agent.process_assistant_event(
                self._make_event([block]),
                emitted_streaming_text=False,
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])

    async def test_falls_back_to_message_content_when_direct_content_empty(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            block = self._make_block("text", text="From message.")
            ev = unittest.mock.MagicMock()
            ev.content = []

            class Msg:
                content = [block]

            ev.message = Msg()
            agent.process_assistant_event(ev, emitted_streaming_text=False)
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        texts = [e["data"].get("text") for e in events if e["event"] == "text_delta"]
        self.assertIn("From message.", texts)

    async def test_empty_text_block_does_not_emit(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            agent.process_assistant_event(
                self._make_event([self._make_block("text", text="")]),
                emitted_streaming_text=False,
            )
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])


class TestProcessUserEvent(unittest.IsolatedAsyncioTestCase):
    """process_user_event emits tool_result events matching the frontend schema."""

    def _make_event_with_blocks(self, blocks):
        class Msg:
            content = blocks

        class Event:
            message = Msg()

        return Event()

    def _make_tool_result(self, tool_use_id, content, is_error=False):
        class Block:
            type = "tool_result"

        b = Block()
        b.tool_use_id = tool_use_id
        b.content = content
        b.is_error = is_error
        return b

    async def test_emits_tool_result_with_string_content(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            block = self._make_tool_result("t1", "file1.txt\nfile2.txt")
            agent.process_user_event(self._make_event_with_blocks([block]))
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "tool_result")
        data = events[0]["data"]
        self.assertEqual(data["tool_use_id"], "t1")
        self.assertEqual(data["content"], "file1.txt\nfile2.txt")
        self.assertFalse(data["is_error"])

    async def test_emits_tool_result_joining_list_content(self):
        class TextBlock:
            type = "text"
            text = "hello output"

        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            block = self._make_tool_result("t2", [TextBlock()])
            agent.process_user_event(self._make_event_with_blocks([block]))
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(events[0]["data"]["content"], "hello output")

    async def test_tool_result_is_error_true_propagated(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            block = self._make_tool_result("err-1", "command not found", is_error=True)
            agent.process_user_event(self._make_event_with_blocks([block]))
        finally:
            agent._emit_writer.reset(token)
        self.assertTrue(writer.written_events()[0]["data"]["is_error"])

    async def test_multiple_tool_result_blocks_each_emit_an_event(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:
            blocks = [
                self._make_tool_result("t3", "result A"),
                self._make_tool_result("t4", "result B"),
            ]
            agent.process_user_event(self._make_event_with_blocks(blocks))
        finally:
            agent._emit_writer.reset(token)
        events = writer.written_events()
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["data"]["tool_use_id"], "t3")
        self.assertEqual(events[1]["data"]["tool_use_id"], "t4")

    async def test_skips_non_tool_result_blocks(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:

            class TextBlock:
                type = "text"
                text = "not a result"

            agent.process_user_event(self._make_event_with_blocks([TextBlock()]))
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])

    async def test_no_output_when_message_is_none(self):
        writer = MockWriter()
        token = agent._emit_writer.set(writer)
        try:

            class Event:
                message = None

            agent.process_user_event(Event())
        finally:
            agent._emit_writer.reset(token)
        self.assertEqual(writer.written_events(), [])


class TestProcessAgentEvent(unittest.IsolatedAsyncioTestCase):
    """process_agent_event dispatches to process_assistant_event or process_user_event."""

    async def test_routes_assistant_type_to_assistant_handler(self):
        with unittest.mock.patch.object(agent, "process_assistant_event") as mock_fn:

            class Event:
                type = "assistant"
                session_id = None

            agent.process_agent_event(Event(), emitted_streaming_text=False)
            mock_fn.assert_called_once()

    async def test_routes_user_type_to_user_handler(self):
        with unittest.mock.patch.object(agent, "process_user_event") as mock_fn:

            class Event:
                type = "user"
                session_id = None

            agent.process_agent_event(Event(), emitted_streaming_text=False)
            mock_fn.assert_called_once()

    async def test_uses_class_name_fallback_for_assistant_message_class(self):
        with unittest.mock.patch.object(agent, "process_assistant_event") as mock_fn:

            class AssistantMessage:
                session_id = None

            agent.process_agent_event(AssistantMessage(), emitted_streaming_text=False)
            mock_fn.assert_called_once()

    async def test_result_and_system_events_do_not_raise(self):
        class ResultEvent:
            type = "result"
            session_id = None
            subtype = "success"

        class SystemEvent:
            type = "system"
            session_id = None
            subtype = "init"

        agent.process_agent_event(ResultEvent(), emitted_streaming_text=False)
        agent.process_agent_event(SystemEvent(), emitted_streaming_text=False)


# ── SDK mock helpers (used by TestRunQuery and TestAskUserQuestionHook) ────


class _StreamEvent:
    """Instances of this class represent raw API streaming events in tests.

    The mock SDK installs this as claude_agent_sdk.types.StreamEvent so that
    isinstance(event, StreamEvent) returns True for these objects and False for
    plain agent-event objects, matching the real SDK's type hierarchy.
    """

    def __init__(self, event_dict: dict):
        self.event = event_dict


def _install_sdk_mock(events=None, raise_exc=None, custom_query=None):
    """Install a mock claude_agent_sdk in sys.modules.

    Returns (old_mods dict) that _restore_sdk_mock uses to put originals back.
    The mock types.StreamEvent is set to _StreamEvent so isinstance checks work.
    """
    mod = types.ModuleType("claude_agent_sdk")
    types_mod = types.ModuleType("claude_agent_sdk.types")

    ev_list = list(events or [])
    exc = raise_exc

    class HookMatcher:
        def __init__(self, matcher, hooks, timeout):
            self.matcher = matcher
            self.hooks = hooks
            self.timeout = timeout

    class ClaudeAgentOptions:
        def __init__(self, **kwargs):
            self.hooks = kwargs.get("hooks", {})

    if custom_query is not None:
        mock_query = custom_query
    else:

        async def mock_query(prompt, options):
            for event in ev_list:
                yield event
            if exc:
                raise exc

    mod.ClaudeAgentOptions = ClaudeAgentOptions
    mod.PermissionResultAllow = object
    mod.query = mock_query
    types_mod.HookMatcher = HookMatcher
    types_mod.StreamEvent = _StreamEvent

    old_mods = {
        k: sys.modules.get(k) for k in ("claude_agent_sdk", "claude_agent_sdk.types")
    }
    sys.modules["claude_agent_sdk"] = mod
    sys.modules["claude_agent_sdk.types"] = types_mod
    return old_mods


def _restore_sdk_mock(old_mods: dict):
    for k, v in old_mods.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v


# ── TestEncoder ───────────────────────────────────────────────────────────


class TestEncoder(unittest.TestCase):
    """_Encoder serialises SDK objects (dataclasses, Pydantic-like) into JSON."""

    def test_serializes_dataclass(self):
        @dataclasses.dataclass
        class FeedEvent:
            name: str
            count: int

        result = json.loads(
            json.dumps(FeedEvent(name="hay", count=3), cls=agent._Encoder)
        )
        self.assertEqual(result, {"name": "hay", "count": 3})

    def test_serializes_pydantic_model_dump(self):
        class PydanticLike:
            def model_dump(self):
                return {"tool_id": "t1", "text": "ok"}

        result = json.loads(json.dumps(PydanticLike(), cls=agent._Encoder))
        self.assertEqual(result, {"tool_id": "t1", "text": "ok"})

    def test_reinjects_type_discriminator_when_missing_from_model_dump(self):
        """The SDK's model_dump() may omit the 'type' key; _Encoder re-injects
        it from the .type attribute so the frontend's event parser can distinguish
        block types (e.g. text vs tool_use)."""

        class PydanticBlock:
            type = "text"

            def model_dump(self):
                return {"text": "hello"}  # no "type" key

        result = json.loads(json.dumps(PydanticBlock(), cls=agent._Encoder))
        self.assertEqual(result["type"], "text")
        self.assertEqual(result["text"], "hello")

    def test_does_not_reinject_type_when_already_present_in_model_dump(self):
        class PydanticBlock:
            type = "should_not_overwrite"

            def model_dump(self):
                return {"type": "tool_use", "id": "t1"}

        result = json.loads(json.dumps(PydanticBlock(), cls=agent._Encoder))
        self.assertEqual(result["type"], "tool_use")  # model_dump value wins

    def test_raises_type_error_for_unrecognised_object(self):
        with self.assertRaises(TypeError):
            json.dumps(object(), cls=agent._Encoder)


# ── TestRouteConnection ───────────────────────────────────────────────────


class TestRouteConnection(unittest.IsolatedAsyncioTestCase):
    """route_connection parses JSON lines and dispatches to the right handler."""

    async def _run_route(self, lines: list[str]) -> None:
        reader = asyncio.StreamReader()
        for line in lines:
            reader.feed_data((line + "\n").encode())
        reader.feed_eof()
        await agent.route_connection(reader, MockWriter())

    async def test_dispatches_query_message_to_handle_query(self):
        with unittest.mock.patch.object(agent, "handle_query") as mock_fn:
            await self._run_route([json.dumps({"type": "query", "content": "hi"})])
            mock_fn.assert_called_once()

    async def test_dispatches_hello_message_to_handle_hello(self):
        with unittest.mock.patch.object(agent, "handle_hello") as mock_fn:
            await self._run_route([json.dumps({"type": "hello", "task_id": "t1"})])
            mock_fn.assert_called_once()

    async def test_dispatches_answer_question_to_handle_answer_question(self):
        with unittest.mock.patch.object(agent, "handle_answer_question") as mock_fn:
            await self._run_route(
                [json.dumps({"type": "answer_question", "request_id": "r1"})]
            )
            mock_fn.assert_called_once()

    async def test_dispatches_interrupt_to_handle_interrupt(self):
        with unittest.mock.patch.object(agent, "handle_interrupt") as mock_fn:
            await self._run_route([json.dumps({"type": "interrupt", "task_id": "t1"})])
            mock_fn.assert_called_once()

    async def test_unknown_message_type_does_not_raise(self):
        await self._run_route([json.dumps({"type": "noop_unknown"})])

    async def test_invalid_json_does_not_raise(self):
        await self._run_route(["not { valid json!!!"])

    async def test_empty_lines_are_skipped(self):
        with unittest.mock.patch.object(agent, "handle_query") as mock_fn:
            await self._run_route(
                ["", "   ", json.dumps({"type": "query", "content": "x"})]
            )
            mock_fn.assert_called_once()

    async def test_multiple_messages_all_dispatched_in_order(self):
        with (
            unittest.mock.patch.object(agent, "handle_hello") as mock_hello,
            unittest.mock.patch.object(agent, "handle_query") as mock_query,
        ):
            await self._run_route(
                [
                    json.dumps({"type": "hello", "task_id": "t1"}),
                    json.dumps({"type": "query", "content": "hi"}),
                ]
            )
            mock_hello.assert_called_once()
            mock_query.assert_called_once()


# ── TestRunQuery ──────────────────────────────────────────────────────────


class TestRunQuery(unittest.IsolatedAsyncioTestCase):
    """run_query emits the correct SSE event sequence and cleans up state."""

    async def _run(
        self, task_id, writer, *, events=None, raise_exc=None, sdk_session_id=None
    ):
        """Run run_query under a mock SDK and return all emitted SSE events."""
        old_mods = _install_sdk_mock(events=events, raise_exc=raise_exc)
        agent._sessions[task_id] = agent.Session(
            task=asyncio.current_task(), writer=writer, conversation_id=""
        )
        token1 = agent._emit_writer.set(writer)
        token2 = agent._emit_session_id.set(task_id)
        try:
            await agent.run_query("test content", sdk_session_id, task_id, "", "/root")
        finally:
            _restore_sdk_mock(old_mods)
            agent._emit_writer.reset(token1)
            agent._emit_session_id.reset(token2)
            agent._sessions.pop(task_id, None)
        return writer.written_events()

    async def test_session_start_is_first_event_with_correct_task_id(self):
        """The frontend captures task_id from session_start to use in stop and
        answer-question requests — it must be the very first event emitted."""
        writer = MockWriter()
        events = await self._run("rq-start", writer)
        self.assertGreater(len(events), 0)
        self.assertEqual(events[0]["event"], "session_start")
        self.assertEqual(events[0]["data"]["task_id"], "rq-start")

    async def test_done_is_last_event_on_successful_completion(self):
        """done triggers history refresh in the frontend; it must always be last."""
        writer = MockWriter()
        events = await self._run("rq-done", writer)
        self.assertEqual(events[-1]["event"], "done")
        self.assertEqual(events[-1]["data"]["task_id"], "rq-done")

    async def test_done_always_emitted_when_exception_raised(self):
        """done fires in the finally block even when the SDK raises."""
        writer = MockWriter()
        events = await self._run("rq-exc", writer, raise_exc=RuntimeError("boom"))
        self.assertEqual(events[-1]["event"], "done")

    async def test_error_event_emitted_before_done_on_exception(self):
        """The frontend shows an error banner on error_event; it must precede done."""
        writer = MockWriter()
        events = await self._run("rq-err", writer, raise_exc=RuntimeError("sdk failed"))
        names = [e["event"] for e in events]
        self.assertIn("error_event", names)
        self.assertIn("done", names)
        self.assertLess(names.index("error_event"), names.index("done"))
        self.assertEqual(
            events[names.index("error_event")]["data"]["message"], "sdk failed"
        )

    async def test_done_emitted_on_cancellation_with_no_error_event(self):
        """When the user clicks Stop, CancelledError is caught; done must still
        fire so the frontend clears the streaming state, and no error banner
        should appear."""
        writer = MockWriter()
        events = await self._run(
            "rq-cancel", writer, raise_exc=asyncio.CancelledError()
        )
        names = [e["event"] for e in events]
        self.assertIn("done", names)
        self.assertNotIn("error_event", names)

    async def test_captured_session_id_from_sdk_event_propagated_to_done(self):
        """The SDK yields events that carry a session_id (the conversation thread
        identifier).  run_query captures the latest one and sends it in done so
        the frontend can resume the session on the next query."""

        class SessionUpdateEvent:
            session_id = "sdk-session-xyz"

        writer = MockWriter()
        events = await self._run("rq-sessid", writer, events=[SessionUpdateEvent()])
        done = next(e for e in events if e["event"] == "done")
        self.assertEqual(done["data"]["session_id"], "sdk-session-xyz")

    async def test_done_session_id_is_none_when_no_session_established(self):
        writer = MockWriter()
        events = await self._run("rq-nosess", writer, sdk_session_id=None)
        done = next(e for e in events if e["event"] == "done")
        self.assertIsNone(done["data"]["session_id"])

    async def test_session_removed_from_registry_after_completion(self):
        """run_query pops its task from _sessions in the finally block so stale
        senders do not accumulate."""
        writer = MockWriter()
        task_id = "rq-cleanup"
        old_mods = _install_sdk_mock()
        agent._sessions[task_id] = agent.Session(
            task=asyncio.current_task(), writer=writer, conversation_id=""
        )
        token1 = agent._emit_writer.set(writer)
        token2 = agent._emit_session_id.set(task_id)
        try:
            await agent.run_query("test", None, task_id, "", "/root")
        finally:
            _restore_sdk_mock(old_mods)
            agent._emit_writer.reset(token1)
            agent._emit_session_id.reset(token2)
        self.assertNotIn(task_id, agent._sessions)

    async def test_streaming_text_flag_suppresses_duplicate_text_from_assistant_event(
        self,
    ):
        """When the SDK streams text via content_block_delta events, the subsequent
        AssistantMessage event must NOT re-emit the same text — the frontend would
        render it twice if it did."""

        class AssistantMessage:
            """Non-_StreamEvent: goes through process_agent_event as 'assistant'."""

            session_id = None
            message = None

            class _TB:
                type = "text"
                text = "Streaming text"

            content = [_TB()]

        stream_events = [
            _StreamEvent(
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text"},
                }
            ),
            _StreamEvent(
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "Streaming text"},
                }
            ),
            _StreamEvent({"type": "content_block_stop", "index": 0}),
            AssistantMessage(),  # same text — must NOT produce a second text_delta
        ]

        writer = MockWriter()
        events = await self._run("rq-dedup", writer, events=stream_events)

        text_deltas = [e for e in events if e["event"] == "text_delta"]
        self.assertEqual(len(text_deltas), 1)
        self.assertEqual(text_deltas[0]["data"]["text"], "Streaming text")


# ── TestAskUserQuestionHook ───────────────────────────────────────────────


class TestAskUserQuestionHook(unittest.IsolatedAsyncioTestCase):
    """The ask_user_question_hook inside run_query drives the interactive Q&A
    flow between Claude and the user via the frontend."""

    async def _run_with_hook(
        self, task_id, writer, hook_caller, *, sdk_session_id=None
    ):
        """Run run_query with a custom mock_query that extracts the
        AskUserQuestion hook and passes it to hook_caller(hook)."""

        class HookMatcher:
            def __init__(self, matcher, hooks, timeout):
                self.matcher = matcher
                self.hooks = hooks
                self.timeout = timeout

        class ClaudeAgentOptions:
            def __init__(self, **kwargs):
                self.hooks = kwargs.get("hooks", {})

        caller = hook_caller

        async def mock_query(prompt, options):
            hook = None
            for hm in options.hooks.get("PreToolUse", []):
                if hm.matcher == "AskUserQuestion":
                    hook = hm.hooks[0]
            if hook is not None:
                await caller(hook)
            if False:
                yield  # make this an async generator

        mod = types.ModuleType("claude_agent_sdk")
        types_mod = types.ModuleType("claude_agent_sdk.types")
        mod.ClaudeAgentOptions = ClaudeAgentOptions
        mod.PermissionResultAllow = object
        mod.query = mock_query
        types_mod.HookMatcher = HookMatcher
        types_mod.StreamEvent = _StreamEvent

        old_mods = {
            k: sys.modules.get(k)
            for k in ("claude_agent_sdk", "claude_agent_sdk.types")
        }
        sys.modules["claude_agent_sdk"] = mod
        sys.modules["claude_agent_sdk.types"] = types_mod

        agent._sessions[task_id] = agent.Session(
            task=asyncio.current_task(), writer=writer, conversation_id=""
        )
        token1 = agent._emit_writer.set(writer)
        token2 = agent._emit_session_id.set(task_id)
        try:
            await agent.run_query("test", sdk_session_id, task_id, "", "/root")
        finally:
            _restore_sdk_mock(old_mods)
            agent._emit_writer.reset(token1)
            agent._emit_session_id.reset(token2)
            agent._sessions.pop(task_id, None)

        return writer.written_events()

    async def test_hook_emits_ask_user_question_with_all_required_frontend_fields(self):
        """The frontend's SseContext expects request_id, task_id, session_id,
        and questions — all must be present in the emitted event."""
        task_id = "aq-fields"
        writer = MockWriter()

        async def call_hook(hook):
            async def resolve():
                agent.handle_answer_question(
                    {"type": "answer_question", "request_id": "req-f", "answers": {}}
                )

            asyncio.create_task(resolve())
            await hook(
                {"tool_input": {"questions": [{"question": "Q1", "options": []}]}},
                "req-f",
                None,
            )

        events = await self._run_with_hook(task_id, writer, call_hook)
        aq_events = [e for e in events if e["event"] == "ask_user_question"]
        self.assertEqual(len(aq_events), 1)
        data = aq_events[0]["data"]
        self.assertIn("request_id", data)
        self.assertIn("task_id", data)
        self.assertIn("session_id", data)
        self.assertIn("questions", data)
        self.assertEqual(data["request_id"], "req-f")
        self.assertEqual(data["task_id"], task_id)

    async def test_hook_session_id_reflects_current_captured_session_id(self):
        """session_id in ask_user_question lets the frontend resume the correct
        conversation thread after the user submits their answer."""
        task_id = "aq-sessid"
        writer = MockWriter()
        sdk_session_id = "existing-sdk-session"

        async def call_hook(hook):
            async def resolve():
                agent.handle_answer_question(
                    {"type": "answer_question", "request_id": "req-s", "answers": {}}
                )

            asyncio.create_task(resolve())
            await hook({"tool_input": {"questions": []}}, "req-s", None)

        events = await self._run_with_hook(
            task_id, writer, call_hook, sdk_session_id=sdk_session_id
        )
        aq_event = next(e for e in events if e["event"] == "ask_user_question")
        self.assertEqual(aq_event["data"]["session_id"], sdk_session_id)

    async def test_hook_round_trip_injects_answers_into_updated_input(self):
        """The hook must return { hookSpecificOutput: { updatedInput: { answers } } }
        so the SDK can pass the user's selections back to AskUserQuestion."""
        task_id = "aq-rt"
        writer = MockWriter()
        hook_results = []

        async def call_hook(hook):
            async def resolve():
                agent.handle_answer_question(
                    {
                        "type": "answer_question",
                        "request_id": "req-rt",
                        "answers": {"Which option?": "Option A"},
                    }
                )

            asyncio.create_task(resolve())
            result = await hook(
                {
                    "tool_input": {
                        "questions": [{"question": "Which option?", "options": []}]
                    }
                },
                "req-rt",
                None,
            )
            hook_results.append(result)

        await self._run_with_hook(task_id, writer, call_hook)

        self.assertEqual(len(hook_results), 1)
        result = hook_results[0]
        self.assertIn("hookSpecificOutput", result)
        updated = result["hookSpecificOutput"]["updatedInput"]
        self.assertEqual(updated["answers"], {"Which option?": "Option A"})

    async def test_hook_returns_none_when_session_removed_before_hook_runs(self):
        """If the session is gone by the time the hook fires (race condition on
        interrupt), the hook returns None without emitting anything or raising."""
        task_id = "aq-gone"
        writer = MockWriter()
        hook_results = []

        async def call_hook(hook):
            agent._sessions.pop(task_id, None)  # simulate race: session already gone
            result = await hook({"tool_input": {"questions": []}}, "req-gone", None)
            hook_results.append(result)

        await self._run_with_hook(task_id, writer, call_hook)

        self.assertEqual(hook_results, [None])
        aq_events = [
            e for e in writer.written_events() if e["event"] == "ask_user_question"
        ]
        self.assertEqual(aq_events, [])

    async def test_hook_raises_timeout_error_when_no_answer_arrives(self):
        """If nobody answers within QUESTION_TIMEOUT_SECS, the hook must raise
        asyncio.TimeoutError rather than hanging forever."""
        task_id = "aq-timeout"
        writer = MockWriter()
        hook_errors = []

        # Temporarily set a very short timeout so the test doesn't take 3600s
        original_timeout = agent.QUESTION_TIMEOUT_SECS
        agent.QUESTION_TIMEOUT_SECS = 0.05  # 50ms

        async def call_hook(hook):
            try:
                await hook({"tool_input": {"questions": []}}, "req-to", None)
            except asyncio.TimeoutError:
                hook_errors.append("timeout")

        try:
            await self._run_with_hook(task_id, writer, call_hook)
        finally:
            agent.QUESTION_TIMEOUT_SECS = original_timeout

        self.assertEqual(hook_errors, ["timeout"])

    async def test_hook_clears_pending_state_on_timeout(self):
        """After a timeout, pending_question and pending_question_data must be
        cleared so the session doesn't hold stale references."""
        task_id = "aq-timeout-cleanup"
        writer = MockWriter()

        original_timeout = agent.QUESTION_TIMEOUT_SECS
        agent.QUESTION_TIMEOUT_SECS = 0.05

        session_ref = [None]

        async def call_hook(hook):
            try:
                await hook({"tool_input": {"questions": []}}, "req-tc", None)
            except asyncio.TimeoutError:
                session_ref[0] = agent._sessions.get(task_id)

        try:
            await self._run_with_hook(task_id, writer, call_hook)
        finally:
            agent.QUESTION_TIMEOUT_SECS = original_timeout

        # The session may have been popped by run_query's finally block,
        # but if we captured it during the hook, pending state should be None
        if session_ref[0] is not None:
            self.assertIsNone(session_ref[0].pending_question)
            self.assertIsNone(session_ref[0].pending_question_data)


# ── handle_connection cleanup tests ───────────────────────────────────────


class _AsyncMockWriter(MockWriter):
    """MockWriter extended with close() and wait_closed() tracking."""

    def __init__(self, closing: bool = False):
        super().__init__(closing)
        self.close_called = False
        self.wait_closed_called = False

    def close(self):
        self.close_called = True

    async def wait_closed(self):
        self.wait_closed_called = True


class TestHandleConnection(unittest.IsolatedAsyncioTestCase):
    """handle_connection calls writer.close() and writer.wait_closed() in all cases."""

    async def test_cleanup_on_normal_route(self):
        """writer.close() and writer.wait_closed() are called after normal completion."""
        reader = asyncio.StreamReader()
        reader.feed_eof()
        writer = _AsyncMockWriter()
        await agent.handle_connection(reader, writer)
        self.assertTrue(writer.close_called)
        self.assertTrue(writer.wait_closed_called)

    async def test_cleanup_when_route_connection_raises(self):
        """writer.close() and writer.wait_closed() are called even when route_connection raises."""
        reader = asyncio.StreamReader()
        reader.feed_eof()
        writer = _AsyncMockWriter()
        with unittest.mock.patch.object(
            agent, "route_connection", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                await agent.handle_connection(reader, writer)
        self.assertTrue(writer.close_called)
        self.assertTrue(writer.wait_closed_called)

    async def test_logs_connected_and_disconnected(self):
        """handle_connection logs client connected / disconnected messages."""
        reader = asyncio.StreamReader()
        reader.feed_eof()
        writer = _AsyncMockWriter()
        with unittest.mock.patch.object(agent, "log") as mock_log:
            await agent.handle_connection(reader, writer)
        messages = [call.args[0] for call in mock_log.call_args_list]
        self.assertTrue(
            any("connected" in m for m in messages),
            f"expected 'connected' log, got: {messages}",
        )
        self.assertTrue(
            any("disconnected" in m for m in messages),
            f"expected 'disconnected' log, got: {messages}",
        )


# ── _log_drain_error callback tests ──────────────────────────────────────


class TestLogDrainError(unittest.IsolatedAsyncioTestCase):
    """_log_drain_error logs only when the task ended with an exception."""

    async def test_logs_when_task_has_exception(self):
        async def fail():
            raise ValueError("drain broke")

        task = asyncio.create_task(fail())
        try:
            await task
        except ValueError:
            pass
        with unittest.mock.patch.object(agent, "log") as mock_log:
            agent._log_drain_error(task)
        mock_log.assert_called_once()
        self.assertIn("drain", mock_log.call_args[0][0])

    async def test_does_nothing_when_task_is_cancelled(self):
        async def wait():
            await asyncio.sleep(999)

        task = asyncio.create_task(wait())
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        with unittest.mock.patch.object(agent, "log") as mock_log:
            agent._log_drain_error(task)
        mock_log.assert_not_called()

    async def test_does_nothing_when_task_completed_successfully(self):
        async def succeed():
            return 42

        task = asyncio.create_task(succeed())
        await task
        with unittest.mock.patch.object(agent, "log") as mock_log:
            agent._log_drain_error(task)
        mock_log.assert_not_called()


# ── ask_user_question_hook with non-dict tool_input ──────────────────────


class TestAskUserQuestionHookNonDictInput(unittest.IsolatedAsyncioTestCase):
    """When tool_input is not a dict, ask_user_question_hook falls back to [] for questions."""

    async def _run_with_hook(self, task_id, writer, hook_caller):
        """Same pattern as TestAskUserQuestionHook._run_with_hook."""

        class HookMatcher:
            def __init__(self, matcher, hooks, timeout):
                self.matcher = matcher
                self.hooks = hooks
                self.timeout = timeout

        class ClaudeAgentOptions:
            def __init__(self, **kwargs):
                self.hooks = kwargs.get("hooks", {})

        caller = hook_caller

        async def mock_query(prompt, options):
            hook = None
            for hm in options.hooks.get("PreToolUse", []):
                if hm.matcher == "AskUserQuestion":
                    hook = hm.hooks[0]
            if hook is not None:
                await caller(hook)
            if False:
                yield

        mod = types.ModuleType("claude_agent_sdk")
        types_mod = types.ModuleType("claude_agent_sdk.types")
        mod.ClaudeAgentOptions = ClaudeAgentOptions
        mod.PermissionResultAllow = object
        mod.query = mock_query
        types_mod.HookMatcher = HookMatcher
        types_mod.StreamEvent = _StreamEvent

        old_mods = {
            k: sys.modules.get(k)
            for k in ("claude_agent_sdk", "claude_agent_sdk.types")
        }
        sys.modules["claude_agent_sdk"] = mod
        sys.modules["claude_agent_sdk.types"] = types_mod

        agent._sessions[task_id] = agent.Session(
            task=asyncio.current_task(), writer=writer, conversation_id=""
        )
        token1 = agent._emit_writer.set(writer)
        token2 = agent._emit_session_id.set(task_id)
        try:
            await agent.run_query("test", None, task_id, "", "/root")
        finally:
            _restore_sdk_mock(old_mods)
            agent._emit_writer.reset(token1)
            agent._emit_session_id.reset(token2)
            agent._sessions.pop(task_id, None)

        return writer.written_events()

    async def test_string_tool_input_falls_back_to_empty_questions(self):
        """When tool_input is a string, questions should default to []."""
        task_id = "aq-nondict-str"
        writer = MockWriter()

        async def call_hook(hook):
            async def resolve():
                agent.handle_answer_question(
                    {"type": "answer_question", "request_id": "req-nd", "answers": {}}
                )

            asyncio.create_task(resolve())
            await hook({"tool_input": "not a dict"}, "req-nd", None)

        events = await self._run_with_hook(task_id, writer, call_hook)
        aq_events = [e for e in events if e["event"] == "ask_user_question"]
        self.assertEqual(len(aq_events), 1)
        self.assertEqual(aq_events[0]["data"]["questions"], [])

    async def test_none_tool_input_falls_back_to_empty_questions(self):
        """When tool_input is None (get_field returns {}), questions should default to []."""
        task_id = "aq-nondict-none"
        writer = MockWriter()

        async def call_hook(hook):
            async def resolve():
                agent.handle_answer_question(
                    {"type": "answer_question", "request_id": "req-nn", "answers": {}}
                )

            asyncio.create_task(resolve())
            # input_data has no tool_input key at all, so get_field returns {} fallback
            await hook({}, "req-nn", None)

        events = await self._run_with_hook(task_id, writer, call_hook)
        aq_events = [e for e in events if e["event"] == "ask_user_question"]
        self.assertEqual(len(aq_events), 1)
        self.assertEqual(aq_events[0]["data"]["questions"], [])


# ── build_prompt_stream tests ─────────────────────────────────────────────


class TestBuildPromptStream(unittest.IsolatedAsyncioTestCase):
    """build_prompt_stream yields exactly one dict with the expected shape."""

    async def test_yields_exactly_one_dict(self):
        items = []
        async for item in agent.build_prompt_stream("hello world"):
            items.append(item)
        self.assertEqual(len(items), 1)

    async def test_yielded_dict_has_expected_shape(self):
        items = []
        async for item in agent.build_prompt_stream("hello world"):
            items.append(item)
        d = items[0]
        self.assertEqual(d["type"], "user")
        self.assertEqual(d["session_id"], "")
        self.assertIsNone(d["parent_tool_use_id"])
        self.assertEqual(d["message"]["role"], "user")
        self.assertEqual(d["message"]["content"], "hello world")

    async def test_user_message_content_matches_input(self):
        content = "test prompt with special chars: <>&"
        items = []
        async for item in agent.build_prompt_stream(content):
            items.append(item)
        self.assertEqual(items[0]["message"]["content"], content)

    async def test_empty_content_string(self):
        items = []
        async for item in agent.build_prompt_stream(""):
            items.append(item)
        self.assertEqual(items[0]["message"]["content"], "")


class TestQuerySemaphore(unittest.IsolatedAsyncioTestCase):
    """Verify the concurrency semaphore limits parallel run_query calls."""

    def test_semaphore_default_allows_three_concurrent(self):
        self.assertEqual(agent._query_semaphore._value, 3)

    async def test_concurrent_queries_limited_by_semaphore(self):
        """With semaphore(1), a second query must wait for the first to finish."""
        original = agent._query_semaphore
        agent._query_semaphore = asyncio.Semaphore(1)
        try:
            order: list[str] = []
            event = asyncio.Event()

            async def slow_query(*args, **kwargs):
                order.append("slow_start")
                await event.wait()
                order.append("slow_end")

            async def fast_query(*args, **kwargs):
                order.append("fast_start")
                order.append("fast_end")

            with unittest.mock.patch.object(
                agent, "_run_query_inner", side_effect=slow_query
            ):
                task1 = asyncio.create_task(
                    agent.run_query("a", None, "t1", "c1", "/tmp")
                )
                await asyncio.sleep(0)  # let task1 acquire semaphore

            with unittest.mock.patch.object(
                agent, "_run_query_inner", side_effect=fast_query
            ):
                task2 = asyncio.create_task(
                    agent.run_query("b", None, "t2", "c2", "/tmp")
                )
                await asyncio.sleep(0)  # task2 should be waiting

                # Only slow_start should have fired
                self.assertEqual(order, ["slow_start"])

                # Release slow query
                event.set()
                await asyncio.gather(task1, task2)

            # fast_query should run after slow_query finishes
            self.assertEqual(
                order, ["slow_start", "slow_end", "fast_start", "fast_end"]
            )
        finally:
            agent._query_semaphore = original


class TestLoadMcpServers(unittest.TestCase):
    """load_mcp_servers merges build-time MCP_SERVERS with ~/.claude.json runtime config."""

    def test_returns_empty_dict_when_no_build_time_or_file(self):
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {}
        try:
            with unittest.mock.patch("builtins.open", side_effect=FileNotFoundError):
                result = agent.load_mcp_servers()
            self.assertEqual(result, {})
        finally:
            agent.MCP_SERVERS = original

    def test_returns_build_time_servers_when_file_not_found(self):
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {
            "builtin": {"type": "http", "url": "http://localhost:8443/mcp"}
        }
        try:
            with unittest.mock.patch("builtins.open", side_effect=FileNotFoundError):
                result = agent.load_mcp_servers()
            self.assertEqual(
                result,
                {"builtin": {"type": "http", "url": "http://localhost:8443/mcp"}},
            )
        finally:
            agent.MCP_SERVERS = original

    def test_returns_file_servers_when_no_build_time(self):
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {}
        try:
            file_content = json.dumps(
                {
                    "mcpServers": {
                        "my-server": {"type": "http", "url": "https://example.com/mcp"}
                    }
                }
            )
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertEqual(
                result,
                {"my-server": {"type": "http", "url": "https://example.com/mcp"}},
            )
        finally:
            agent.MCP_SERVERS = original

    def test_merges_build_time_and_file_servers(self):
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {
            "builtin": {"type": "http", "url": "http://localhost:8443/mcp"}
        }
        try:
            file_content = json.dumps(
                {
                    "mcpServers": {
                        "runtime": {"type": "http", "url": "https://runtime.com/mcp"}
                    }
                }
            )
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertIn("builtin", result)
            self.assertIn("runtime", result)
            self.assertEqual(result["builtin"]["url"], "http://localhost:8443/mcp")
            self.assertEqual(result["runtime"]["url"], "https://runtime.com/mcp")
        finally:
            agent.MCP_SERVERS = original

    def test_file_servers_override_build_time_on_name_conflict(self):
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {"shared": {"type": "http", "url": "http://old.com"}}
        try:
            file_content = json.dumps(
                {"mcpServers": {"shared": {"type": "http", "url": "https://new.com"}}}
            )
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertEqual(result["shared"]["url"], "https://new.com")
        finally:
            agent.MCP_SERVERS = original

    def test_handles_invalid_json_in_file(self):
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {"builtin": {"type": "http"}}
        try:
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data="not valid json")
            ):
                result = agent.load_mcp_servers()
            self.assertEqual(result, {"builtin": {"type": "http"}})
        finally:
            agent.MCP_SERVERS = original

    def test_handles_file_with_no_mcp_servers_key(self):
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {}
        try:
            file_content = json.dumps({"env": {"FOO": "bar"}})
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertEqual(result, {})
        finally:
            agent.MCP_SERVERS = original

    def test_does_not_mutate_original_mcp_servers(self):
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {"builtin": {"type": "http"}}
        try:
            file_content = json.dumps({"mcpServers": {"extra": {"type": "http"}}})
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertNotIn("extra", agent.MCP_SERVERS)
            self.assertIn("extra", result)
        finally:
            agent.MCP_SERVERS = original

    def test_preserves_headers_from_file(self):
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {}
        try:
            file_content = json.dumps(
                {
                    "mcpServers": {
                        "auth-server": {
                            "type": "http",
                            "url": "https://example.com/mcp",
                            "headers": {"Authorization": "Bearer sk-123"},
                        }
                    }
                }
            )
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertEqual(
                result["auth-server"]["headers"]["Authorization"], "Bearer sk-123"
            )
        finally:
            agent.MCP_SERVERS = original


class TestLoadMcpServersOAuth(unittest.TestCase):
    """OAuth-stored MCP server configs are loaded correctly with headers and tokens."""

    def test_loads_oauth_server_with_authorization_header(self):
        """Server stored by OAuth callback includes Authorization header."""
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {}
        try:
            file_content = json.dumps(
                {
                    "mcpServers": {
                        "figma": {
                            "type": "http",
                            "url": "https://mcp.figma.com/mcp",
                            "headers": {"Authorization": "Bearer access-token-123"},
                        }
                    }
                }
            )
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertIn("figma", result)
            self.assertEqual(result["figma"]["url"], "https://mcp.figma.com/mcp")
            self.assertEqual(
                result["figma"]["headers"]["Authorization"],
                "Bearer access-token-123",
            )
        finally:
            agent.MCP_SERVERS = original

    def test_loads_oauth_server_with_refresh_token_metadata(self):
        """Server stored by OAuth callback includes _refresh_token field."""
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {}
        try:
            file_content = json.dumps(
                {
                    "mcpServers": {
                        "figma": {
                            "type": "http",
                            "url": "https://mcp.figma.com/mcp",
                            "headers": {"Authorization": "Bearer tok"},
                            "_refresh_token": "refresh-456",
                        }
                    }
                }
            )
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertIn("figma", result)
            self.assertEqual(result["figma"]["_refresh_token"], "refresh-456")
        finally:
            agent.MCP_SERVERS = original

    def test_oauth_server_merges_with_build_time_servers(self):
        """OAuth runtime servers merge alongside build-time servers."""
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {
            "builtin": {"type": "http", "url": "http://localhost:8443/mcp"}
        }
        try:
            file_content = json.dumps(
                {
                    "mcpServers": {
                        "figma": {
                            "type": "http",
                            "url": "https://mcp.figma.com/mcp",
                            "headers": {"Authorization": "Bearer tok"},
                        }
                    }
                }
            )
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertIn("builtin", result)
            self.assertIn("figma", result)
            self.assertEqual(result["builtin"]["url"], "http://localhost:8443/mcp")
            self.assertNotIn("headers", result["builtin"])
            self.assertEqual(result["figma"]["headers"]["Authorization"], "Bearer tok")
        finally:
            agent.MCP_SERVERS = original

    def test_oauth_server_without_headers_still_loads(self):
        """An OAuth server entry missing headers still loads (graceful)."""
        original = agent.MCP_SERVERS
        agent.MCP_SERVERS = {}
        try:
            file_content = json.dumps(
                {
                    "mcpServers": {
                        "no-headers": {
                            "type": "http",
                            "url": "https://example.com/mcp",
                        }
                    }
                }
            )
            with unittest.mock.patch(
                "builtins.open", unittest.mock.mock_open(read_data=file_content)
            ):
                result = agent.load_mcp_servers()
            self.assertIn("no-headers", result)
            self.assertEqual(result["no-headers"]["url"], "https://example.com/mcp")
        finally:
            agent.MCP_SERVERS = original


class TestSlashCommandRouting(unittest.IsolatedAsyncioTestCase):
    """Slash commands (e.g. /commit) are sent via build_prompt_stream like
    regular messages — the SDK's internal CLI subprocess handles parsing.
    The key requirement is that allowed_tools includes 'Skill' and
    setting_sources includes 'project' so the SDK can discover skills."""

    async def _capture_prompt(self, content: str) -> list[dict]:
        """Run run_query and capture what was passed to the mock query()."""
        captured_items: list[dict] = []

        async def spy_query(prompt, options):
            async for item in prompt:
                captured_items.append(item)
            return
            yield  # make it an async generator

        old_mods = _install_sdk_mock(custom_query=spy_query)
        task_id = f"slash-{content[:10]}"
        writer = MockWriter()
        agent._sessions[task_id] = agent.Session(
            task=asyncio.current_task(), writer=writer, conversation_id=""
        )
        token1 = agent._emit_writer.set(writer)
        token2 = agent._emit_session_id.set(task_id)
        try:
            await agent.run_query(content, None, task_id, "", "/root")
        finally:
            _restore_sdk_mock(old_mods)
            agent._emit_writer.reset(token1)
            agent._emit_session_id.reset(token2)
            agent._sessions.pop(task_id, None)
        return captured_items

    async def test_slash_command_sent_via_async_iterable(self):
        """Slash commands go through build_prompt_stream for SDK compatibility."""
        items = await self._capture_prompt("/commit")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["message"]["content"], "/commit")
        self.assertEqual(items[0]["type"], "user")

    async def test_slash_command_with_args(self):
        items = await self._capture_prompt("/compact summarize briefly")
        self.assertEqual(items[0]["message"]["content"], "/compact summarize briefly")

    async def test_regular_message_sent_via_async_iterable(self):
        items = await self._capture_prompt("hello world")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["message"]["content"], "hello world")


if __name__ == "__main__":
    unittest.main()
