import { useEffect, useState } from "react";
import { MAX_MEMORY } from "../../shared/types.ts";
import { api } from "../api.ts";
import { inMemory, withLessons } from "../model.ts";
import { Button, Notice } from "./UI.tsx";

const memoryUrl = (workdir: string) => `/api/projects/memory?workdir=${encodeURIComponent(workdir)}`;
const saveMemory = (workdir: string, memory: string) =>
  api<{ memory: string }>("/api/projects/memory", { method: "PUT", body: { workdir, memory } });

/** The project's memory, loaded for `workdir`; null until it arrives. */
function useMemory(workdir: string) {
  const [memory, setMemory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setMemory(null);
    api<{ memory: string }>(memoryUrl(workdir))
      .then((res) => live && setMemory(res.memory))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [workdir]);
  return { memory, setMemory, error, setError };
}

const TRUST = "Every agent in this project’s runs reads it and follows it unsandboxed, like your brief.";

/** Edits what every run in `workdir` is told about the project. */
export function MemoryEditor({ workdir }: { workdir: string }) {
  const { memory, setMemory, error, setError } = useMemory(workdir);
  const [draft, setDraft] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const text = draft ?? memory ?? "";
  const save = async () => {
    setState("saving");
    setError(null);
    try {
      setMemory((await saveMemory(workdir, text)).memory);
      setDraft(null);
      setState("saved");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };
  return (
    <div className="project-memory">
      <label>
        Project memory
        <span className="hint">
          Notes for later runs in this folder: how to check it, pitfalls, preferences. The Director suggests additions when it accepts a build. {TRUST}
        </span>
        <textarea
          rows={4}
          maxLength={MAX_MEMORY}
          value={text}
          disabled={memory === null}
          onChange={(e) => {
            setDraft(e.target.value);
            setState("idle");
          }}
          placeholder={memory === null ? "Loading…" : "- Check with bun test && bun run typecheck\n- Never edit generated files in src/gen/"}
        />
      </label>
      <p className="actions">
        <Button type="button" variant="small" disabled={draft === null || draft === memory || state === "saving"} onClick={save}>
          {state === "saving" ? "Saving…" : "Save memory"}
        </Button>
        {state === "saved" && <span className="hint" role="status">Saved</span>}
      </p>
      {error && <Notice>{error}</Notice>}
      <ProjectLessons workdir={workdir} onMemoryChanged={(value, lesson) => { setMemory(value); setDraft((current) => current === null ? null : withLessons(current, [lesson.text])); setState("idle"); }} />
    </div>
  );
}

export type ProjectLesson = { id: string; runId: string; commit: string; text: string; evidenceIds: string[]; status: "proposed" | "accepted" | "retired"; createdAt: number };

function ProjectLessons({ workdir, onMemoryChanged }: { workdir: string; onMemoryChanged: (memory: string, lesson: ProjectLesson) => void }) {
  const [lessons, setLessons] = useState<ProjectLesson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    try {
      setLessons((await api<{ lessons: ProjectLesson[] }>(`/api/projects/lessons?workdir=${encodeURIComponent(workdir)}`)).lessons);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [workdir]);
  const update = async (lesson: ProjectLesson, status: "accepted" | "retired") => {
    if (busy) return;
    setBusy(lesson.id);
    setError(null);
    try {
      await api("/api/projects/lessons", { method: "PUT", body: { workdir, id: lesson.id, status } });
      if (status === "accepted") onMemoryChanged((await api<{ memory: string }>(memoryUrl(workdir))).memory, lesson);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  if (!lessons.length && !error) return null;
  return <details className="project-lessons"><summary>Lessons with evidence · {lessons.filter((lesson) => lesson.status === "proposed").length} proposed</summary>
    <p className="hint">Lessons stay linked to the revision and checks that informed them. Remembering a lesson adds it to project memory. Retiring stops proposing it; edit project memory to remove saved wording.</p>
    {lessons.map((lesson) => <LessonProvenance key={lesson.id} lesson={lesson} busy={busy !== null} onChange={(status) => void update(lesson, status)} />)}
    {error && <Notice retry={load}>{error}</Notice>}
  </details>;
}

export function LessonProvenance({ lesson, busy, onChange }: { lesson: ProjectLesson; busy: boolean; onChange: (status: "accepted" | "retired") => void }) {
  return <article className="lesson-provenance">
    <p className="pre-wrap">{lesson.text}</p>
    <p className="hint"><span className="lesson-status">{lesson.status === "accepted" ? "Accepted" : lesson.status === "retired" ? "Retired" : "Proposed"}</span> · <a href={`#/runs/${encodeURIComponent(lesson.runId)}`}>Source run</a> · <code title={lesson.commit}>{lesson.commit.slice(0, 12)}</code></p>
    <details><summary>Evidence provenance</summary><p className="hint">{new Date(lesson.createdAt).toLocaleString()}</p><ul>{lesson.evidenceIds.map((id) => <li key={id}><code className="wrap">{id}</code></li>)}</ul></details>
    <p className="actions">{lesson.status !== "accepted" && <Button type="button" variant="small" disabled={busy} onClick={() => onChange("accepted")}>Remember lesson</Button>}{lesson.status !== "retired" && <Button type="button" variant="small ghost" disabled={busy} onClick={() => onChange("retired")}>Retire lesson</Button>}</p>
  </article>;
}

/** The Director's proposed lessons from a finished run; the user picks which the project keeps. */
export function LessonsPicker({ workdir, lessons }: { workdir: string; lessons: string[] }) {
  const { memory, setMemory, error, setError } = useMemory(workdir);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const chosen = memory === null ? [] : lessons.filter((l) => !inMemory(memory, l) && !skipped.has(l));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setMemory((await saveMemory(workdir, withLessons(memory ?? "", chosen))).memory);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="member-options lessons">
      <legend>Lessons for this project</legend>
      <p className="hint">The Director suggests remembering these for later runs in this folder. {TRUST}</p>
      {lessons.map((lesson) => {
        const saved = memory !== null && inMemory(memory, lesson);
        return (
          <label key={lesson} className="autonomy-option">
            <input
              type="checkbox"
              checked={saved || !skipped.has(lesson)}
              disabled={saved || memory === null || busy}
              onChange={(e) => setSkipped((s) => {
                const next = new Set(s);
                if (e.target.checked) next.delete(lesson);
                else next.add(lesson);
                return next;
              })}
            />
            <span>
              {lesson}
              {saved && <span className="hint">In project memory</span>}
            </span>
          </label>
        );
      })}
      {chosen.length > 0 && (
        <p className="actions">
          <Button type="button" variant="small" disabled={busy} onClick={save}>
            {busy ? "Saving…" : `Remember ${chosen.length} ${chosen.length === 1 ? "lesson" : "lessons"}`}
          </Button>
        </p>
      )}
      {error && <Notice>{error}</Notice>}
    </fieldset>
  );
}
