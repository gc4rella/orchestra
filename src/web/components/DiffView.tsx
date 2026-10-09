import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import type { DiffFile, ReviewComment, Run, Task } from "../../shared/types.ts";
import { api } from "../api.ts";
import { diffRows } from "../model.ts";
import { Button, Loading, Notice } from "./UI.tsx";

const STATUS_MARK: Record<DiffFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

/**
 * The run's changes, whole or per merged task. Comments on lines are collected and sent to the Director
 * in one batch, which plans the fixes.
 */
export function DiffView({
  run,
  tasks,
  canComment,
  busy,
  onSend,
}: {
  run: Run;
  tasks: Task[];
  /** Whether the run is between plans, so feedback can go to the Director. */
  canComment: boolean;
  busy: boolean;
  /** Resolves to whether the comments were sent. */
  onSend: (comments: ReviewComment[], note: string) => Promise<boolean>;
}) {
  const [scope, setScope] = useState("");
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [editing, setEditing] = useState<{ file: string; line: number; removed: boolean } | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const requestVersion = useRef(0);
  const merged = tasks.filter((t) => t.mergeCommit);
  // New merges change the diff.
  const version = `${run.status}:${merged.length}`;

  const load = async () => {
    const request = ++requestVersion.current;
    setError(null);
    setFiles(null);
    setEditing(null);
    try {
      const list = await api<DiffFile[]>(`/api/runs/${run.id}/diff${scope ? `?taskId=${encodeURIComponent(scope)}` : ""}`);
      if (request !== requestVersion.current) return;
      setFiles(list);
      setPath((p) => (p && list.some((f) => f.path === p) ? p : (list[0]?.path ?? null)));
    } catch (e) {
      if (request !== requestVersion.current) return;
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    return () => { requestVersion.current++; };
  }, [run.id, scope, version]);

  const file = files?.find((f) => f.path === path) ?? null;
  const added = files?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const removed = files?.reduce((n, f) => n + f.deletions, 0) ?? 0;
  const startComment = (line: number, isRemoved: boolean) => {
    if (!file) return;
    setEditing({ file: file.path, line, removed: isRemoved });
    setText("");
  };
  const addComment = (e: FormEvent) => {
    e.preventDefault();
    if (!file || !editing || !text.trim()) return;
    const body = editing.removed ? `(on a removed line) ${text.trim()}` : text.trim();
    setComments([...comments, { file: file.path, line: editing.line, text: body }]);
    setEditing(null);
  };
  const send = async () => {
    if (await onSend(comments, note.trim())) {
      setComments([]);
      setNote("");
    }
  };

  return (
    <section className="diff-view" aria-label="Changes">
      <div className="diff-toolbar">
        <label>
          <span className="sr-only">Show changes from</span>
          <select aria-label="Show changes from" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">The whole run</option>
            {merged.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        {files && (
          <span className="hint">
            {files.length} file{files.length === 1 ? "" : "s"} · <span className="diff-add-count">+{added}</span>{" "}
            <span className="diff-del-count">−{removed}</span>
          </span>
        )}
      </div>
      {error && <Notice retry={load}>{error}</Notice>}
      {!files && !error && <Loading label="Loading changes" />}
      {files && !files.length && <p className="quiet-note">No changes yet.</p>}
      {files && files.length > 0 && (
        <div className="diff-body">
          <ul className="diff-files" aria-label="Changed files">
            {files.map((f) => {
              const count = comments.filter((c) => c.file === f.path).length;
              return (
                <li key={f.path}>
                  <button aria-pressed={f.path === path} onClick={() => setPath(f.path)} title={f.path}>
                    <span className={`diff-mark diff-${f.status}`} title={f.status}>
                      {STATUS_MARK[f.status]}
                      <span className="sr-only"> {f.status}</span>
                    </span>
                    <span className="diff-path mono">{f.path}</span>
                    <span className="diff-counts">
                      {count > 0 && <span className="diff-comment-count">{count} ✎</span>}+{f.additions} −{f.deletions}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {file && (
            <div className="diff-file">
              <div className="diff-file-head">
                <strong className="mono">{file.path}</strong>
                {file.oldPath && <span className="hint"> renamed from {file.oldPath}</span>}
              </div>
              {file.binary ? (
                <p className="quiet-note">Binary file; not shown.</p>
              ) : !file.patch ? (
                <p className="quiet-note">No content changes.</p>
              ) : (
                <div className="diff-scroll">
                  <table className="diff-table">
                    <tbody>
                      {diffRows(file.patch).map((row, i) => {
                        if (row.kind === "hunk") {
                          return (
                            <tr key={i} className="diff-hunk">
                              <td colSpan={3} className="mono">
                                {row.text}
                              </td>
                            </tr>
                          );
                        }
                        const line = row.newLine ?? row.oldLine!;
                        const isRemoved = row.kind === "del";
                        const here = comments.filter((c) => c.file === file.path && c.line === line);
                        const open = editing?.file === file.path && editing.line === line && editing.removed === isRemoved;
                        return (
                          <Fragment key={i}>
                            <tr className={`diff-line diff-${row.kind}`}>
                              <td className="diff-num">{row.oldLine ?? ""}</td>
                              <td className="diff-num">
                                {canComment ? (
                                  <button
                                    className="diff-comment-button"
                                    aria-label={`Comment on ${isRemoved ? "removed " : ""}line ${line}`}
                                    onClick={() => startComment(line, isRemoved)}
                                  >
                                    {row.newLine ?? "+"}
                                  </button>
                                ) : (
                                  (row.newLine ?? "")
                                )}
                              </td>
                              <td className="diff-code mono">
                                <span aria-hidden="true">{row.kind === "add" ? "+" : isRemoved ? "−" : " "}</span>
                                {row.text}
                              </td>
                            </tr>
                            {!isRemoved &&
                              here.map((c, j) => (
                                <tr key={`c${j}`} className="diff-note">
                                  <td colSpan={3}>
                                    <span>✎ {c.text}</span>
                                  </td>
                                </tr>
                              ))}
                            {open && (
                              <tr className="diff-note">
                                <td colSpan={3}>
                                  <form className="diff-comment-form" onSubmit={addComment}>
                                    <label>
                                      <span className="sr-only">Comment on line {line}</span>
                                      <textarea
                                        autoFocus
                                        rows={2}
                                        maxLength={2000}
                                        value={text}
                                        placeholder="What should change here?"
                                        onChange={(e) => setText(e.target.value)}
                                      />
                                    </label>
                                    <div className="revise-actions">
                                      <Button type="button" variant="small ghost" onClick={() => setEditing(null)}>
                                        Cancel
                                      </Button>
                                      <Button type="submit" variant="small" disabled={!text.trim() || comments.length >= 50}>
                                        Add comment
                                      </Button>
                                    </div>
                                  </form>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {file.truncated && <p className="quiet-note">This diff is too long to show in full.</p>}
            </div>
          )}
        </div>
      )}
      {canComment ? (
        files && (
          <div className="review-tray">
            <p>
              {comments.length ? (
                <strong>
                  {comments.length} comment{comments.length === 1 ? "" : "s"} for the Director.{" "}
                </strong>
              ) : (
                "Select a line number to comment on it. "
              )}
              The Director plans fixes from your feedback.
            </p>
            {comments.length > 0 && (
              <ul>
                {comments.map((c, i) => (
                  <li key={i}>
                    <span className="mono">
                      {c.file}:{c.line}
                    </span>{" "}
                    {c.text}{" "}
                    <button className="text-button" onClick={() => setComments(comments.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label>
              {comments.length ? "Anything else?" : "Changes you'd like"}
              <textarea rows={2} maxLength={10000} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="revise-actions">
              <Button variant="primary" disabled={busy || (!comments.length && !note.trim())} onClick={send}>
                {busy ? "Sending…" : "Send to the Director"}
              </Button>
            </div>
          </div>
        )
      ) : (
        <p className="quiet-note">You can comment on the changes once the team has stopped working.</p>
      )}
    </section>
  );
}
