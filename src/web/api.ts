import { useEffect, useRef } from "react";
import type { ServerEvent } from "../shared/types.ts";

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
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
export function useEvents(topic: string, onEvent: (ev: ServerEvent) => void, onReconnect?: () => void) {
  const handlers = useRef({ onEvent, onReconnect });
  handlers.current = { onEvent, onReconnect };

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let connectedBefore = false;

    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => {
        ws?.send(JSON.stringify({ subscribe: topic }));
        // Events may have been missed while disconnected: let the page refetch.
        if (connectedBefore) handlers.current.onReconnect?.();
        connectedBefore = true;
      };
      ws.onmessage = (m) => handlers.current.onEvent(JSON.parse(m.data) as ServerEvent);
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [topic]);
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
