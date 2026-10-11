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
    </div>
  );
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
