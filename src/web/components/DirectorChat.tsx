import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DirectorChatTurn, Run } from "../../shared/types.ts";
import { api, useEvents } from "../api.ts";
import { Button, Connection, Notice } from "./UI.tsx";

export function mergeChatTurns(previous: DirectorChatTurn[], incoming: DirectorChatTurn[]) {
  const turns = new Map(previous.map((turn) => [turn.id, turn]));
  for (const turn of incoming) {
    // A pending HTTP response can arrive after the completed WebSocket event.
    if (turn.status === "pending" && turns.get(turn.id)?.status !== "pending" && turns.has(turn.id)) continue;
    turns.set(turn.id, turn);
  }
  return [...turns.values()].sort((a, b) => a.id - b.id);
}

export function DirectorChat({ run, director, open, onClose }: { run: Run; director: string; open: boolean; onClose: () => void }) {
  const [turns, setTurns] = useState<DirectorChatTurn[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const path = `/api/runs/${run.id}/chat`;
  const load = async () => {
    try {
      const history = await api<DirectorChatTurn[]>(path);
      setTurns((previous) => mergeChatTurns(previous, history));
      setError(null);
      setLoading(false);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [run.id]);
  const connection = useEvents(`run:${run.id}`, (event) => {
    if (event.type === "director-chat" && event.runId === run.id) setTurns((previous) => mergeChatTurns(previous, [event.turn]));
  }, load);
  useEffect(() => { if (open && !sending) input.current?.focus({ preventScroll: true }); }, [open, sending]);
  useEffect(() => {
    const element = transcript.current;
    if (open && element && following.current) element.scrollTop = element.scrollHeight;
  }, [turns, open]);
  const pending = turns.some((turn) => turn.status === "pending");
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || loading || pending || !text.trim()) return;
    lock.current = true;
    setSending(true);
    setError(null);
    try {
      const turn = await api<DirectorChatTurn>(path, { body: { text: text.trim() } });
      following.current = true;
      setTurns((previous) => mergeChatTurns(previous, [turn]));
      setText("");
    } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setSending(false); input.current?.focus({ preventScroll: true }); }
  };
  return <aside id="director-chat" className="director-chat" aria-label="Chat with the Director" hidden={!open}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="director-chat-head">
      <div><p className="eyebrow">Side conversation</p><h2>Ask the Director</h2><p className="muted">{director}</p></div>
      <Button variant="small ghost" aria-label="Close Director chat" onClick={onClose}>Close</Button>
    </header>
    <div className="director-chat-context"><span>Current plan & team progress</span><Connection state={connection} /></div>
    <div className="director-chat-transcript" role="log" aria-label="Director conversation" aria-live="polite" aria-relevant="additions text" ref={transcript}
      onScroll={() => { const el = transcript.current!; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {loading && !error && <p className="muted" role="status">Loading conversation…</p>}
      {!loading && !turns.length && <div className="director-chat-empty"><h3>A question along the way?</h3><p>Ask about the approach, what the team is doing, or a decision in the current plan.</p><p className="hint">Your conversation stays separate from instructions to the team.</p></div>}
      {turns.map((turn) => <div className="director-chat-turn" key={turn.id}>
        <div className="director-chat-question"><strong>You</strong><p>{turn.text}</p></div>
        <div className="director-chat-reply"><strong>Director</strong>
          {turn.status === "pending" ? <p className="muted" role="status">Waiting for the Director’s reply…</p>
            : turn.status === "failed" ? <div className="director-chat-failure"><p>{turn.error}</p><Button variant="small ghost" disabled={pending || sending} onClick={() => { setText(turn.text); input.current?.focus(); }}>Use question again</Button></div>
              : <p>{turn.reply}</p>}
        </div>
      </div>)}
    </div>
    <form className="director-chat-compose" onSubmit={send}>
      {error && <Notice retry={load}>{error}</Notice>}
      <label htmlFor="director-question" className="sr-only">Question for the Director</label>
      <textarea id="director-question" ref={input} rows={3} maxLength={10000} value={text} disabled={sending}
        onChange={(event) => setText(event.target.value)} placeholder="Ask about this run…"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
      <div className="director-chat-send"><span className="hint">Enter to send · Shift+Enter for a new line</span><Button type="submit" variant="small" disabled={loading || sending || pending || !text.trim()}>{sending ? "Sending…" : "Send"}</Button></div>
      <p className="hint">Chat uses your Director’s model without starting or resuming work. To change the work, use the team’s controls.</p>
    </form>
  </aside>;
}
