import React, { useCallback, useEffect, useRef } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import type { ITerminalOptions } from "@xterm/xterm";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useSse } from "../contexts/SseContext";

const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  theme: { background: "#000000" },
  fontFamily: "monospace",
  fontSize: 14,
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Number of silent WS reconnect attempts before falling back to a full page
// reload.  A reload lets the server assign a fresh VM (with a new vmId) when
// the original VM was swept for idleness.
const MAX_RECONNECT_ATTEMPTS = 5;

function buildWsUrl(vmId: string): string {
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${window.location.host}/ws/${encodeURIComponent(vmId)}`;
}

export default function Terminal({ visible }: { visible: boolean }) {
  const { vmId } = useSse();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermAttachedRef = useRef(false);
  // Buffer WS messages received before xterm is attached
  const messageBufferRef = useRef<ArrayBuffer[]>([]);
  // Track the latest onData disposable so we can re-wire on reconnect
  const dataDisposableRef = useRef<{ dispose(): void } | null>(null);
  // Track consecutive connection failures (open never fires before close)
  const consecutiveFailRef = useRef(0);

  // Reconnect state
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);

  // Wire (or re-wire) a WS to the xterm instance + health monitoring
  const wireWs = useCallback((ws: WebSocket) => {
    wsRef.current = ws;

    const sendResize = () => {
      const term = termRef.current;
      if (term && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }),
        );
      }
    };

    ws.addEventListener("open", () => {
      reconnectAttemptRef.current = 0;
      consecutiveFailRef.current = 0;
      const term = termRef.current;
      if (term) {
        // Re-wire input to the new WS
        dataDisposableRef.current?.dispose();
        dataDisposableRef.current = term.onData((d) =>
          ws.send(new TextEncoder().encode(d)),
        );
        sendResize();
      }
    });

    ws.addEventListener("close", () => {
      consecutiveFailRef.current++;
      const term = termRef.current;
      if (term) {
        term.write("\r\n\x1b[2mreconnecting…\x1b[0m\r\n");
      }
      scheduleReconnect();
    });

    ws.addEventListener("message", (e: MessageEvent) => {
      const term = termRef.current;
      if (term) {
        term.write(new Uint8Array(e.data as ArrayBuffer));
      } else {
        messageBufferRef.current.push(e.data as ArrayBuffer);
      }
    });
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return;
    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      // Stop retrying — don't reload the page, as the VM may be gone and
      // reloading would trigger a provision loop.  The user can still interact
      // with the rest of the UI (e.g. the Reset button) and refresh manually.
      const term = termRef.current;
      if (term) {
        term.write("\r\n\x1b[2munable to reconnect\x1b[0m\r\n");
      }
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, attempt),
      RECONNECT_MAX_MS,
    );
    reconnectAttemptRef.current = attempt + 1;
    reconnectTimerRef.current = setTimeout(() => {
      if (unmountedRef.current) return;
      const ws = new WebSocket(buildWsUrl(vmId));
      ws.binaryType = "arraybuffer";
      wireWs(ws);
    }, delay);
  }, [vmId, wireWs]);

  // Open initial WS eagerly on mount
  useEffect(() => {
    if (!vmId) return;
    unmountedRef.current = false;
    const ws = new WebSocket(buildWsUrl(vmId));
    ws.binaryType = "arraybuffer";
    wireWs(ws);

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [vmId, wireWs]);

  const attachXterm = useCallback(() => {
    if (xtermAttachedRef.current) return;
    if (!containerRef.current) return;
    xtermAttachedRef.current = true;

    const term = new XTerm(TERMINAL_OPTIONS);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    term.focus();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Replay any buffered messages
    for (const buf of messageBufferRef.current) {
      term.write(new Uint8Array(buf));
    }
    messageBufferRef.current = [];

    const ws = wsRef.current;
    if (!ws) return;

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }),
        );
      }
    };

    term.onResize(() => {
      const currentWs = wsRef.current;
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        currentWs.send(
          JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }),
        );
      }
    });

    dataDisposableRef.current = term.onData((d) =>
      ws.send(new TextEncoder().encode(d)),
    );

    if (ws.readyState === WebSocket.OPEN) {
      sendResize();
    } else {
      ws.addEventListener("open", () => sendResize(), { once: true });
    }

    const ro = new ResizeObserver(() => fitAddon.fit());
    ro.observe(containerRef.current);
  }, []);

  // Initialize xterm lazily on first visible
  useEffect(() => {
    if (visible) {
      attachXterm();
    }
  }, [visible, attachXterm]);

  // Fit on resize / visibility change
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 50);
    }
  }, [visible]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black">
      {!xtermAttachedRef.current && !visible && (
        <div className="flex flex-1 items-center justify-center text-gray-500">
          <TerminalIcon className="mr-2 h-5 w-5" />
          <span className="text-sm">Terminal</span>
        </div>
      )}
      <div
        ref={containerRef}
        className="min-h-0 flex-1"
        style={{ display: visible ? "block" : "none" }}
      />
    </div>
  );
}
