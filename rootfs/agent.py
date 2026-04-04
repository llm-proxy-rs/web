# /// script
# requires-python = ">=3.14"
# dependencies = ["claude-agent-sdk>=0.1.52"]
# ///
import asyncio
import contextvars
import dataclasses
import json
import os
import signal
import sys
import uuid
from typing import Any

SOCKET_PATH = "/tmp/agent.sock"
QUESTION_TIMEOUT_SECS = 3600
MCP_PROXY_PORT = 8443
# Replaced by build_rootfs.py when --mcp-base-url is provided.
MCP_SERVERS: dict = {}


def load_mcp_servers() -> dict:
    """Merge build-time MCP_SERVERS with runtime servers from ~/.claude.json."""
    servers = dict(MCP_SERVERS)
    try:
        with open(os.path.expanduser("~/.claude.json")) as f:
            data = json.load(f)
        servers.update(data.get("mcpServers", {}))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return servers


# Allowed root directories for work_dir. Populated at startup via _init_allowed_roots().
_ALLOWED_WORK_DIR_ROOTS: list[str] = []


def log(msg: str) -> None:
    """Write a log line to stderr so it appears in server logs without polluting the stdout protocol."""
    sys.stderr.write(f"[agent] {msg}\n")
    sys.stderr.flush()


def _default_home() -> str:
    """Return the best available home directory when HOME is not set."""
    for candidate in ("/home/ubuntu", "/root"):
        if os.path.isdir(candidate):
            return candidate
    return "/root"


def _init_allowed_roots() -> None:
    home = os.path.realpath(os.environ.get("HOME") or _default_home())
    tmp = os.path.realpath("/tmp")
    for root in [home, tmp]:
        if root not in _ALLOWED_WORK_DIR_ROOTS:
            _ALLOWED_WORK_DIR_ROOTS.append(root)


def resolve_work_dir(raw: str | None) -> str:
    """Resolve and validate a work_dir path.

    Returns the real path when it falls within an allowed root directory and
    exists on disk, otherwise falls back to HOME.
    """
    fallback = os.path.realpath(os.environ.get("HOME") or _default_home())
    if not raw:
        return fallback
    real = os.path.realpath(raw)
    for root in _ALLOWED_WORK_DIR_ROOTS:
        if real == root or real.startswith(root + os.sep):
            if os.path.isdir(real):
                return real
    log("work_dir outside allowed roots, using fallback")
    return fallback


_init_allowed_roots()


@dataclasses.dataclass
class Session:
    task: asyncio.Task
    writer: asyncio.StreamWriter
    conversation_id: str
    pending_question: asyncio.Future | None = None
    pending_question_data: dict | None = None
    cancelled: bool = False


# All live sessions keyed by task_id (a server-generated UUID).
_sessions: dict[str, Session] = {}

# Limit concurrent run_query tasks to avoid resource exhaustion on the VM.
# Configurable via AGENT_MAX_CONCURRENT_QUERIES (default 3).
_query_semaphore = asyncio.Semaphore(
    int(os.environ.get("AGENT_MAX_CONCURRENT_QUERIES", "3"))
)

# Per-task context vars: set at task-creation time so emit_sse always routes to
# the connection that submitted the query, even as _sessions[id].writer changes
# on reconnect.
_emit_writer: contextvars.ContextVar[asyncio.StreamWriter | None] = (
    contextvars.ContextVar("emit_writer", default=None)
)
_emit_session_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "emit_session_id", default=None
)


def _log_drain_error(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception():
        log(f"drain error: {task.exception()}")


def write_sse(writer: asyncio.StreamWriter, event_name: str, data: dict) -> None:
    """Write an SSE event directly to a specific writer."""
    if writer.is_closing():
        return
    payload = f"event: {event_name}\ndata: {json.dumps(data, cls=_Encoder)}\n\n"
    writer.write(payload.encode())
    drain_task = asyncio.get_running_loop().create_task(writer.drain())
    drain_task.add_done_callback(_log_drain_error)


def emit_sse(event_name: str, data: dict) -> None:
    """Write an SSE event to the task-captured writer.

    Falls back to the session's current writer when the original writer has
    closed (e.g. the client disconnected and reconnected mid-query).
    """
    # Suppress events (except done/error) when the session has been cancelled
    # to prevent buffered responses from reaching the client after stop.
    task_id = _emit_session_id.get()
    if task_id and event_name not in ("done", "error_event"):
        session = _sessions.get(task_id)
        if session and session.cancelled:
            return
    writer = _emit_writer.get()
    if writer is None or writer.is_closing():
        session = _sessions.get(task_id) if task_id else None
        writer = session.writer if session else None
    if writer is None or writer.is_closing():
        return
    write_sse(writer, event_name, data)


def get_field(obj: Any, field: str, default: Any = None) -> Any:
    """Get a field from either a dict or an object attribute."""
    if isinstance(obj, dict):
        return obj.get(field, default)
    return getattr(obj, field, default)


# ── Per-message-type handlers ─────────────────────────────────────────────────


def handle_hello(msg: dict, writer: asyncio.StreamWriter) -> None:
    """Bind a reconnected client connection to its existing session."""
    task_id = msg.get("task_id")
    if not task_id:
        return
    session = _sessions.get(task_id)
    if not session:
        log(f"hello for unknown session {task_id!r}, notifying client")
        write_sse(writer, "done", {"session_id": None, "task_id": task_id})
        return
    log(f"client rebound to session {task_id!r}")
    session.writer = writer
    if session.pending_question_data:
        log("re-emitting pending question to reconnected client")
        write_sse(writer, "ask_user_question", session.pending_question_data)


def handle_answer_question(msg: dict) -> None:
    """Deliver an answer to whichever session is waiting on that request_id."""
    request_id = msg.get("request_id")
    for session in _sessions.values():
        if (
            session.pending_question
            and not session.pending_question.done()
            and session.pending_question_data
            and session.pending_question_data.get("request_id") == request_id
        ):
            session.pending_question.set_result(msg.get("answers", {}))
            return
    log(f"answer_question for unknown request_id {request_id!r}")


def handle_interrupt(msg: dict) -> None:
    """Cancel the query task identified by task_id."""
    task_id = msg.get("task_id")
    if not task_id:
        return
    session = _sessions.get(task_id)
    if session and not session.task.done():
        log(f"interrupt received for session {task_id!r}, cancelling")
        session.cancelled = True
        session.task.cancel()


def handle_query(msg: dict, writer: asyncio.StreamWriter) -> None:
    """Spawn a new run_query task and register it in _sessions."""
    sdk_session_id = msg.get("session_id")  # non-None when resuming
    task_id = msg.get("task_id") or str(uuid.uuid4())
    conversation_id = msg.get("conversation_id", "")
    work_dir = resolve_work_dir(msg.get("work_dir"))
    # Cancel any existing session with the same task_id to prevent orphaned tasks
    existing = _sessions.get(task_id)
    if existing and not existing.task.done():
        log(f"duplicate task_id {task_id!r}, cancelling previous session")
        existing.cancelled = True
        existing.task.cancel()
        _sessions.pop(task_id, None)
    token1 = _emit_writer.set(writer)
    token2 = _emit_session_id.set(task_id)
    task = asyncio.create_task(
        run_query(
            msg.get("content", ""), sdk_session_id, task_id, conversation_id, work_dir
        )
    )
    _emit_writer.reset(token1)
    _emit_session_id.reset(token2)
    _sessions[task_id] = Session(
        task=task, writer=writer, conversation_id=conversation_id
    )
    log(f"query started  task_id={task_id!r}  resume={sdk_session_id!r}")


# ── Connection handling ───────────────────────────────────────────────────────


async def route_connection(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    """Read lines from a connected client and dispatch to the appropriate handler."""
    while True:
        raw = await reader.readline()
        if not raw:
            return
        line = raw.decode().strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log("failed to parse line: invalid JSON")
            continue
        msg_type = msg.get("type")
        if msg_type == "hello":
            handle_hello(msg, writer)
        elif msg_type == "answer_question":
            handle_answer_question(msg)
        elif msg_type == "interrupt":
            handle_interrupt(msg)
        elif msg_type == "query":
            handle_query(msg, writer)
        else:
            log(f"unknown message type: {msg_type!r}")


async def handle_connection(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    """Handle a single client connection."""
    log("client connected")
    try:
        await route_connection(reader, writer)
    finally:
        writer.close()
        await writer.wait_closed()
        log("client disconnected")


async def main():
    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass
    old_umask = os.umask(0o177)  # Create socket with 0o600 permissions
    server = await asyncio.start_unix_server(
        handle_connection, path=SOCKET_PATH, limit=1_048_576  # 1 MB max line length
    )
    os.umask(old_umask)
    loop = asyncio.get_running_loop()

    def remove_socket():
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, remove_socket)

    log("agent daemon ready")
    async with server:
        await server.serve_forever()


# ── Query execution ───────────────────────────────────────────────────────────


async def build_prompt_stream(content: str):
    yield {
        "type": "user",
        "session_id": "",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": None,
    }


async def run_query(
    content: str,
    sdk_session_id: str | None,
    task_id: str,
    conversation_id: str,
    work_dir: str,
):
    async with _query_semaphore:
        await _run_query_inner(
            content, sdk_session_id, task_id, conversation_id, work_dir
        )


async def _run_query_inner(
    content: str,
    sdk_session_id: str | None,
    task_id: str,
    conversation_id: str,
    work_dir: str,
):
    from claude_agent_sdk import ClaudeAgentOptions, PermissionResultAllow, query
    from claude_agent_sdk.types import HookMatcher, StreamEvent

    log(
        f"query start  task_id={task_id!r}  resume={sdk_session_id!r}  content_len={len(content)}"
    )
    emit_sse("session_start", {"task_id": task_id})

    captured_session_id = sdk_session_id

    async def handle_tool_permission(tool_name, input_, context):
        # Allow all tools unconditionally. This is safe because the agent runs
        # inside an isolated Firecracker microVM — the VM itself is the security
        # boundary, so no additional tool-level filtering is needed here.
        log(f"can_use_tool called  tool_name={tool_name!r}")
        return PermissionResultAllow()

    async def ask_user_question_hook(input_data, tool_use_id, context):
        session = _sessions.get(task_id)
        if not session:
            return
        tool_input = get_field(input_data, "tool_input") or {}
        questions = (
            tool_input.get("questions", []) if isinstance(tool_input, dict) else []
        )
        question_data = {
            "request_id": tool_use_id,
            "task_id": task_id,
            "conversation_id": conversation_id,
            "session_id": captured_session_id,
            "questions": questions,
        }
        session.pending_question = asyncio.get_running_loop().create_future()
        session.pending_question_data = question_data
        emit_sse("ask_user_question", question_data)
        log("PreToolUse AskUserQuestion: waiting for answer")
        try:
            answers = await asyncio.wait_for(
                session.pending_question, timeout=QUESTION_TIMEOUT_SECS
            )
        except asyncio.TimeoutError:
            log("PreToolUse AskUserQuestion: timed out waiting for answer")
            session.pending_question = None
            session.pending_question_data = None
            raise
        session.pending_question = None
        session.pending_question_data = None
        log("PreToolUse AskUserQuestion: answered")
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": {**tool_input, "answers": answers},
            }
        }

    options = ClaudeAgentOptions(
        cwd=work_dir,
        setting_sources=["user"],
        can_use_tool=handle_tool_permission,
        mcp_servers=load_mcp_servers(),
        hooks={
            "PreToolUse": [
                HookMatcher(
                    matcher="AskUserQuestion",
                    hooks=[ask_user_question_hook],
                    timeout=QUESTION_TIMEOUT_SECS,
                )
            ],
        },
        **({"resume": sdk_session_id} if sdk_session_id else {}),
    )

    # Per-block tracking for streaming deltas: index -> type / tool-info / accumulated-input
    block_types: dict[int, str] = {}
    tool_info: dict[int, dict] = {}
    tool_input: dict[int, str] = {}
    # Whether text was already emitted via streaming deltas; if so, skip re-emitting
    # from the full AssistantEvent to avoid duplicates.
    emitted_streaming_text = False
    try:
        async for event in query(prompt=build_prompt_stream(content), options=options):
            if hasattr(event, "session_id") and event.session_id:
                captured_session_id = event.session_id
            if isinstance(event, StreamEvent):
                had_text = process_stream_event(
                    event, block_types, tool_info, tool_input
                )
                if had_text:
                    emitted_streaming_text = True
            else:
                process_agent_event(event, emitted_streaming_text)
    except asyncio.CancelledError:
        log(f"query cancelled  task_id={task_id!r}")
    except Exception as exc:
        log(f"query error: {exc}")
        log(f"query error type: {type(exc).__name__}")
        log(
            f"query error attrs: {vars(exc) if hasattr(exc, '__dict__') else 'no __dict__'}"
        )
        for attr in ("stderr", "output", "returncode", "cmd", "exit_code"):
            if hasattr(exc, attr):
                log(f"query error {attr}: {getattr(exc, attr)!r}")
        emit_sse("error_event", {"message": str(exc) or "An internal error occurred"})
    finally:
        log(f"query done  task_id={task_id!r}  session_id={captured_session_id!r}")
        emit_sse(
            "done",
            {
                "session_id": captured_session_id,
                "task_id": task_id,
                "conversation_id": conversation_id,
            },
        )
        session = _sessions.pop(task_id, None)
        if session:
            session.pending_question = None
            session.pending_question_data = None


# ── StreamEvent (raw API streaming) ───────────────────────────────────────────


def process_stream_event(
    event,
    block_types: dict,
    tool_info: dict,
    tool_input: dict,
) -> bool:
    """Process a raw API streaming event. Returns True if any text was emitted."""
    ev = event.event
    ev_type = get_field(ev, "type")
    if ev_type == "content_block_start":
        return process_block_start(ev, block_types, tool_info, tool_input)
    elif ev_type == "content_block_delta":
        return process_block_delta(ev, block_types, tool_info, tool_input)
    elif ev_type == "content_block_stop":
        process_block_stop(ev, block_types, tool_info, tool_input)
    elif ev_type not in (
        "message_start",
        "message_delta",
        "message_stop",
        "ping",
        None,
    ):
        log(f"stream_event  {ev_type}")
    return False


def process_block_start(
    ev, block_types: dict, tool_info: dict, tool_input: dict
) -> bool:
    idx = get_field(ev, "index", 0)
    block = get_field(ev, "content_block")
    block_type = get_field(block, "type")
    block_types[idx] = block_type
    if block_type == "text":
        emit_sse("init", {})
        return True
    elif block_type == "tool_use":
        tool_info[idx] = {
            "id": get_field(block, "id"),
            "name": get_field(block, "name"),
        }
        tool_input[idx] = ""
    return False


def process_block_delta(
    ev, block_types: dict, tool_info: dict, tool_input: dict
) -> bool:
    idx = get_field(ev, "index", 0)
    delta = get_field(ev, "delta")
    delta_type = get_field(delta, "type")
    if delta_type == "text_delta":
        text = get_field(delta, "text", "")
        if text:
            emit_sse("text_delta", {"text": text})
            return True
    elif delta_type == "thinking_delta":
        thinking = get_field(delta, "thinking", "")
        if thinking:
            emit_sse("thinking_delta", {"thinking": thinking})
    elif delta_type == "input_json_delta":
        partial = get_field(delta, "partial_json", "") or ""
        tool_input[idx] = tool_input.get(idx, "") + partial
    return False


def process_block_stop(
    ev, block_types: dict, tool_info: dict, tool_input: dict
) -> None:
    idx = get_field(ev, "index", 0)
    if block_types.get(idx) == "tool_use" and idx in tool_info:
        raw_input = tool_input.pop(idx, "{}") or "{}"
        try:
            input_data = json.loads(raw_input)
        except json.JSONDecodeError:
            input_data = {}
        info = tool_info.pop(idx)
        if info["name"] != "AskUserQuestion":
            emit_sse(
                "tool_start",
                {"id": info["id"], "name": info["name"], "input": input_data},
            )
    block_types.pop(idx, None)


# ── Non-StreamEvent (structured agent events) ─────────────────────────────────


def _class_to_event_type(event) -> str | None:
    """Derive event type from class name for SDKs that don't set a .type attribute.

    e.g. AssistantMessage -> 'assistant', ResultMessage -> 'result'
    """
    name = type(event).__name__
    if name.endswith("Message"):
        return name[: -len("Message")].lower()
    return None


def _derive_block_type(block) -> str | None:
    """Derive content block type from class name when .type attribute is absent.

    e.g. TextBlock -> 'text', ToolUseBlock -> 'tool_use', ThinkingBlock -> 'thinking'
    """
    name = type(block).__name__
    if name == "TextBlock":
        return "text"
    if name == "ToolUseBlock":
        return "tool_use"
    if name == "ThinkingBlock":
        return "thinking"
    return None


def process_agent_event(event, emitted_streaming_text: bool) -> None:
    event_type = get_field(event, "type") or _class_to_event_type(event)
    log(
        f"agent_event  type={event_type!r}  session_id={getattr(event, 'session_id', None)!r}"
    )
    if event_type == "assistant":
        process_assistant_event(event, emitted_streaming_text)
    elif event_type == "user":
        process_user_event(event)
    elif event_type == "result":
        log(f"result  subtype={getattr(event, 'subtype', '?')}")
    elif event_type == "system":
        log(f"system  subtype={getattr(event, 'subtype', '?')}")


def emit_assistant_block(block) -> None:
    block_type = getattr(block, "type", None) or _derive_block_type(block)
    if block_type == "text":
        text = getattr(block, "text", "") or ""
        if text:
            emit_sse("init", {})
            emit_sse("text_delta", {"text": text})
    elif block_type == "thinking":
        thinking = getattr(block, "thinking", "") or ""
        if thinking:
            emit_sse("thinking_delta", {"thinking": thinking})
    elif block_type == "tool_use":
        block_name = getattr(block, "name", None) or ""
        if block_name != "AskUserQuestion":
            emit_sse(
                "tool_start",
                {
                    "id": getattr(block, "id", None),
                    "name": block_name,
                    "input": getattr(block, "input", {}) or {},
                },
            )


def process_assistant_event(event, emitted_streaming_text: bool) -> None:
    # AssistantMessage exposes .content directly (no .message wrapper)
    content_blocks = getattr(event, "content", None) or []
    if not content_blocks:
        msg = getattr(event, "message", None)
        content_blocks = getattr(msg, "content", []) or [] if msg else []
    block_types = [getattr(b, "type", type(b).__name__) for b in content_blocks]
    log(f"assistant  blocks={block_types}")
    if emitted_streaming_text:
        # All content (text deltas and tool_start) already delivered via streaming events.
        return
    for block in content_blocks:
        emit_assistant_block(block)


def emit_tool_result_block(block) -> None:
    raw_content = getattr(block, "content", None)
    if isinstance(raw_content, list):
        content_str = " ".join(
            getattr(b, "text", "") or ""
            for b in raw_content
            if getattr(b, "type", None) == "text"
        )
    else:
        content_str = str(raw_content) if raw_content is not None else ""
    emit_sse(
        "tool_result",
        {
            "tool_use_id": getattr(block, "tool_use_id", None),
            "content": content_str,
            "is_error": getattr(block, "is_error", False) or False,
        },
    )


def process_user_event(event) -> None:
    msg = getattr(event, "message", None)
    if not msg:
        return
    tool_ids = []
    for block in getattr(msg, "content", []) or []:
        if getattr(block, "type", None) != "tool_result":
            continue
        tool_ids.append(getattr(block, "tool_use_id", None))
        emit_tool_result_block(block)
    log(f"user tool_results  tool_use_ids={tool_ids}")


class _Encoder(json.JSONEncoder):
    def default(self, obj):
        if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
            data = dataclasses.asdict(obj)
        elif hasattr(obj, "model_dump"):
            data = obj.model_dump()
        else:
            return super().default(obj)
        # Pydantic model_dump() may omit discriminator `type`; re-inject from attribute if missing.
        if isinstance(data, dict) and "type" not in data:
            type_val = getattr(obj, "type", None)
            if type_val is not None:
                data["type"] = type_val if isinstance(type_val, str) else str(type_val)
        return data


asyncio.run(main())
