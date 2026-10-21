import { useEffect, useRef, useState } from "react";
import type { MergeCheck, Run } from "../../shared/types.ts";
import { api } from "../api.ts";
import { shellQuote } from "../model.ts";
import { Button, CopyButton } from "./UI.tsx";

export function MergeReadiness({ run }: { run: Run }) {
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<{ revision: string; check: MergeCheck } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  const revision = `${run.id}:${run.acceptedCommit ?? ""}`;
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  useEffect(() => {
    version.current++;
    setResult(null);
    setError(null);
    setChecking(false);
    return () => { version.current++; };
  }, [revision]);

  const checkMerge = async () => {
    const request = ++version.current;
    const requestedRevision = revision;
    const requestedTarget = target.trim();
    const current = () => request === version.current && requestedRevision === currentRevision.current;
    setResult(null);
    setError(null);
    setChecking(true);
    try {
      const check = await api<MergeCheck>(`/api/runs/${run.id}/merge-check`, { body: requestedTarget ? { target: requestedTarget } : {} });
      if (!current()) return;
      if (run.acceptedCommit && check.sourceCommit !== run.acceptedCommit) {
        setError("The run revision changed. Check the merge again.");
        return;
      }
      setResult({ revision: requestedRevision, check });
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) setChecking(false);
    }
  };

  const check = result?.revision === revision ? result.check : null;
  const command = check?.status === "clean" && check.targetBranch
    ? `git -C ${shellQuote(run.workdir)} switch -- ${shellQuote(check.targetBranch)} && git -C ${shellQuote(run.workdir)} merge -- ${shellQuote(check.sourceCommit)}`
    : null;
  const verdict = check?.status === "clean" ? "Merges cleanly" : check?.status === "conflicted" ? "Conflicts found" : "Merge check unavailable";
  return <details className="merge-readiness">
    <summary>Check before merging</summary>
    {!run.timeouts ? <p className="hint" role="status">Local merge checks require a newer Orchestra server. Restart Orchestra after active runs have stopped to enable them.</p> : <div className="merge-readiness-body">
      <p className="hint">Compare with a local branch without changing your checkout. This checks for merge conflicts; it does not rerun the combined build’s tests.</p>
      <form className="merge-readiness-form" onSubmit={(e) => { e.preventDefault(); void checkMerge(); }}>
        <label>Merge into branch (optional)
          <input className="mono" maxLength={200} autoComplete="off" spellCheck={false} placeholder="Current project branch" value={target} onChange={(e) => {
            version.current++;
            setTarget(e.target.value);
            setResult(null);
            setError(null);
            setChecking(false);
          }} />
        </label>
        <Button variant="small" type="submit" disabled={checking} aria-busy={checking}>{checking ? "Checking…" : "Check merge"}</Button>
      </form>
      {error && <p className="field-error" role="alert">{error}</p>}
      {check && <div className="merge-readiness-result">
        <p className="merge-readiness-status" role="status">
          <span className={`status status-${check.status === "clean" ? "done" : check.status === "conflicted" ? "failed" : "blocked"}`}>{verdict}</span>
          {check.targetBranch && <span>Into <code>{check.targetBranch}</code></span>}
        </p>
        <dl className="merge-readiness-revisions">
          <div><dt>Source revision</dt><dd><code title={check.sourceCommit}>{check.sourceCommit.slice(0, 12)}</code></dd></div>
          {check.targetCommit && <div><dt>Target revision</dt><dd><code title={check.targetCommit}>{check.targetCommit.slice(0, 12)}</code></dd></div>}
        </dl>
        {check.message && <p className="hint">{check.message}</p>}
        {check.conflicts.length > 0 && <ul className="merge-readiness-conflicts" aria-label="Conflicting files">
          {check.conflicts.map((path) => <li key={path}><code>{path}</code></li>)}
        </ul>}
        {command && <div className="command-row">
          <code>{command}</code>
          <CopyButton text={command} label="Copy checked merge command" />
        </div>}
      </div>}
    </div>}
  </details>;
}
