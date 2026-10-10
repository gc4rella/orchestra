import { useEffect, useRef, useState } from "react";
import type { ServerEvent } from "../shared/types.ts";

export async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

/** Subscribes to a server event topic ("runs" or "run:<id>") and reconnects if the socket drops. */
export function useEvents(
  topic: string,
  onEvent: (ev: ServerEvent) => void,
  onReconnect?: () => void,
) {
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "reconnecting"
  >("connecting");
  const handlers = useRef({ onEvent, onReconnect });
  handlers.current = { onEvent, onReconnect };

  useEffect(() => {
    setConnection("connecting");
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      ws.onopen = () => {
        setConnection("connected");
        ws?.send(JSON.stringify({ subscribe: topic }));
        // Events may have been missed while disconnected: let the page refetch.
        handlers.current.onReconnect?.();
      };
      ws.onmessage = (m) => {
        try {
          handlers.current.onEvent(JSON.parse(m.data) as ServerEvent);
        } catch {
          /* Ignore malformed events; reconnect refreshes state. */
        }
      };
      ws.onclose = () => {
        if (!closed) {
          setConnection("reconnecting");
          retry = setTimeout(connect, 1500);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [topic]);
  // Keep the workspace current when a local proxy or browser blocks WebSockets.
  useEffect(() => {
    if (connection !== "reconnecting") return;
    const timer = setInterval(() => handlers.current.onReconnect?.(), 10000);
    return () => clearInterval(timer);
  }, [connection]);
  return connection;
}

export const navigate = (hash: string) => {
  location.hash = hash;
};

export function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** The tab title is a page name plus how many runs need the user; pages and the run watcher set one part each. */
const title = { base: "Orchestra", attention: 0 };
export function setTitle(part: { base?: string; attention?: number }) {
  Object.assign(title, part);
  document.title = `${title.attention ? `(${title.attention}) ` : ""}${title.base}`;
}
