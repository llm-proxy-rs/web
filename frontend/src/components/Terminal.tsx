import React, { useCallback, useEffect, useRef, useState } from "react";
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

export default function Terminal({ visible }: { visible: boolean }) {
  const { vmId } = useSse();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const initializedRef = useRef(false);

  const initShell = useCallback(() => {
    if (initializedRef.current) return;
    if (!containerRef.current) return;
    initializedRef.current = true;

    const term = new XTerm(TERMINAL_OPTIONS);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    term.focus();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/${encodeURIComponent(vmId)}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
      }
    };

    term.onResize(sendResize);

    ws.onopen = () => {
      term.onData((d) => ws.send(new TextEncoder().encode(d)));
      sendResize();
      ws.send(new TextEncoder().encode("claude --resume\r"));
    };

    ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = () => term.write("\r\n\x1b[2mconnection closed\x1b[0m\r\n");

    const ro = new ResizeObserver(() => fitAddon.fit());
    ro.observe(containerRef.current);
  }, [vmId]);

  // Initialize lazily on first visible
  useEffect(() => {
    if (visible) {
      initShell();
    }
  }, [visible, initShell]);

  // Fit on resize / visibility change
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 50);
    }
  }, [visible]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black">
      {!initializedRef.current && !visible && (
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
