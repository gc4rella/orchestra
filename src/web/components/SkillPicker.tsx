import { useEffect, useState } from "react";
import type { Skill, SkillListing } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Button } from "./UI.tsx";

/** Matches the server's cap on skills per agent. */
export const MAX_SKILLS = 20;

const installs = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

/** Picks skills.sh skills for an agent. New picks have no description until the server installs them on save. */
export function SkillPicker({ value, onChange }: { value: Skill[]; onChange: (skills: Skill[]) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillListing[] | null>(null);
  const [status, setStatus] = useState<"idle" | "searching" | string>("idle");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setStatus("idle");
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      setStatus("searching");
      api<SkillListing[]>(`/api/skills/search?q=${encodeURIComponent(q)}`)
        .then((r) => { if (!stale) { setResults(r); setStatus("idle"); } })
        .catch((e) => { if (!stale) { setResults(null); setStatus((e as Error).message); } });
    }, 300);
    return () => { stale = true; clearTimeout(timer); };
  }, [query]);

  const chosen = new Set(value.map((s) => s.id));
  const full = value.length >= MAX_SKILLS;
  return (
    <div className="skill-picker">
      <span className="skill-picker-label">
        Skills <span className="optional">Optional · from skills.sh</span>
      </span>
      {value.length > 0 ? (
        <ul className="skill-list">
          {value.map((s) => (
            <li key={s.id}>
              <div>
                <a href={`https://skills.sh/${s.id}`} target="_blank" rel="noreferrer">{s.name}</a>
                <span className="hint mono">{s.id.split("/").slice(0, 2).join("/")}</span>
                <p className="hint">{s.description || "Installed when you save."}</p>
              </div>
              <Button type="button" variant="small ghost" aria-label={`Remove ${s.name}`} onClick={() => onChange(value.filter((v) => v.id !== s.id))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">No skills yet. Skills give the agent expert playbooks it reads when a task calls for them.</p>
      )}
      <label>
        <span className="sr-only">Search skills.sh</span>
        <input
          type="search"
          value={query}
          maxLength={100}
          disabled={full}
          onChange={(e) => setQuery(e.target.value)}
          // Enter would submit the agent form.
          onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
          placeholder={full ? `Up to ${MAX_SKILLS} skills` : "Search skills, e.g. react, testing, security"}
        />
      </label>
      <p className="hint" role="status">
        {status === "searching" ? "Searching skills.sh…"
          : status !== "idle" ? status
          : results && !results.length ? "No skills match that search."
          : ""}
      </p>
      {results && results.length > 0 && (
        <ul className="skill-results">
          {results.map((r) => (
            <li key={r.id}>
              <div>
                <strong>{r.name}</strong>
                <span className="hint mono">{r.id.split("/").slice(0, 2).join("/")} · {installs(r.installs)} installs</span>
              </div>
              <Button
                type="button"
                variant="small"
                disabled={chosen.has(r.id) || full}
                aria-label={chosen.has(r.id) ? `${r.name} added` : `Add ${r.name}`}
                onClick={() => onChange([...value, { id: r.id, name: r.name, description: "" }])}
              >
                {chosen.has(r.id) ? "Added" : "＋ Add"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Skills are third-party instructions, and sometimes scripts, that the agent follows with full access to its
        workspace. Add only ones you trust; each links to its page on skills.sh.
      </p>
    </div>
  );
}
