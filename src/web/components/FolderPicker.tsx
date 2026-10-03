import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FolderListing } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Button, Drawer, FolderIcon, Loading, Notice } from "./UI.tsx";

const folderUrl = (path?: string) => `/api/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`;

export function FolderPicker({ start, onPick, onClose }: { start?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [newName, setNewName] = useState("");
  const request = useRef(0);

  const open = async (path?: string, fallbackHome = false) => {
    const id = ++request.current;
    try {
      const next = await api<FolderListing>(folderUrl(path));
      if (id !== request.current) return; // a newer navigation won
      setListing(next);
      setLocation(next.path);
      setFilter("");
      setError(null);
    } catch (e) {
      if (id !== request.current) return;
      if (fallbackHome) return void open();
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    // Start where the current path points; a path that doesn't exist yet falls back to home.
    void open(start?.startsWith("/") ? start : undefined, true);
  }, []);

  const go = (e: FormEvent) => {
    e.preventDefault();
    const path = location.trim();
    if (path) void open(listing ? path.replace(/^~(?=\/|$)/, listing.home) : path);
  };
  const shown = listing?.folders.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const nameProblem =
    /[/\\]/.test(newName) || [".", ".."].includes(newName.trim()) ? "Use a single folder name, without slashes." : null;
  const pickNew = (e: FormEvent) => {
    e.preventDefault();
    if (listing && newName.trim() && !nameProblem) onPick(`${listing.path.replace(/\/$/, "")}/${newName.trim()}`);
  };

  return (
    <Drawer layout="modal" title="Choose a project folder" eyebrow={null} closeLabel="Close" busy={false} onClose={onClose}>
      <div className="folder-picker">
        <form className="location-field" onSubmit={go}>
          <span className="field-icon">
            <FolderIcon />
          </span>
          <input
            className="mono"
            aria-label="Folder path"
            aria-describedby="location-help"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Type a path and press Enter"
            spellCheck={false}
            autoComplete="off"
          />
        </form>
        <p id="location-help" className="sr-only">Type or paste a folder path and press Enter to open it.</p>
        <div className="folder-toolbar">
          <Button type="button" variant="small ghost" disabled={!listing?.parent} onClick={() => listing?.parent && open(listing.parent)}>
            ↑ Up
          </Button>
          <Button type="button" variant="small ghost" disabled={!listing || listing.path === listing.home} onClick={() => listing && open(listing.home)}>
            Home
          </Button>
          <input type="search" aria-label="Filter folders" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {error && <Notice>{error}</Notice>}
        {!listing && !error && <Loading label="Loading folders" />}
        {listing && (
          <ul className="folder-list" aria-label={`Folders in ${listing.path}`}>
            {shown.length === 0 && <li className="folder-list-empty">{filter ? "No folders match." : "No folders here."}</li>}
            {shown.map((f) => (
              <li key={f.path}>
                <button type="button" onClick={() => open(f.path)}>
                  <FolderIcon />
                  <span className="folder-name">{f.name}</span>
                  {f.repo && <span className="runtime-badge">git</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing && (
          <form className="new-folder" onSubmit={pickNew}>
            <label htmlFor="new-folder">Or start a new project in this folder</label>
            <div className="new-folder-row">
              <input
                id="new-folder"
                className="mono"
                value={newName}
                placeholder="my-new-app"
                onChange={(e) => setNewName(e.target.value)}
                aria-invalid={!!nameProblem}
                aria-describedby={nameProblem ? "new-folder-error" : "new-folder-help"}
              />
              <Button type="submit" variant="small" disabled={!newName.trim() || !!nameProblem}>
                Use new folder
              </Button>
            </div>
            {nameProblem ? (
              <p id="new-folder-error" className="field-error">{nameProblem}</p>
            ) : (
              <p id="new-folder-help" className="hint">Created when the run starts.</p>
            )}
          </form>
        )}
      </div>
      <div className="drawer-footer">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
          Use this folder
        </Button>
      </div>
    </Drawer>
  );
}
