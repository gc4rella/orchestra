import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewState, Run } from "../src/shared/types.ts";
import { LivePreview } from "../src/web/components/LivePreview.tsx";

test("a browser bundle updated against an older server renders a restart notice instead of crashing", () => {
  const run = { id: "old-run" } as Run;
  const html = renderToStaticMarkup(<LivePreview run={run} preview={null} busy={false} onConfigure={async () => { throw new Error("Must not call the older API"); }} />);
  expect(html).toContain("Restart Orchestra to enable live previews");
  expect(html).not.toContain("Start preview");
});

test("a current server response renders the preview controls", () => {
  const run = { id: "new-run", preview: { enabled: false, command: "" } } as Run;
  const html = renderToStaticMarkup(<LivePreview run={run} preview={null} busy={false} onConfigure={async () => true} />);
  expect(html).toContain("Start preview");
  expect(html).not.toContain("server is running an older version");
});

const ready: PreviewState = { status: "ready", url: "http://127.0.0.1:5432", commit: "abcdef123456", updatedAt: 1, message: "Live · latest integrated work", output: "" };
const enabledRun = { id: "preview-run", preview: { enabled: true, command: "" } } as Run;

test("unverified working files are distinguished from integrated builds", () => {
  const html = renderToStaticMarkup(<LivePreview run={enabledRun} preview={{ ...ready, draft: true }} busy={false} onConfigure={async () => true} />);
  expect(html).toContain("Work in progress · checks pending");
  expect(html).not.toContain("Integrated build");
});

test("the preview defers its app until the workspace section is first visited", () => {
  const render = (visible: boolean) => renderToStaticMarkup(<LivePreview run={enabledRun} preview={ready} visible={visible} busy={false} onConfigure={async () => true} />);
  expect(render(false)).not.toContain("<iframe");
  expect(render(true)).toContain('<iframe src="http://127.0.0.1:5432"');
  expect(render(true)).toContain("Open in new tab");
  expect(render(true)).not.toContain("live-preview-body");
});

test("a failed preview offers a focused restart action and its server message", () => {
  const html = renderToStaticMarkup(<LivePreview run={enabledRun} preview={{ ...ready, status: "failed", url: null, message: "Port unavailable" }} busy={false} onConfigure={async () => true} />);
  expect(html).toContain("Restart preview");
  expect(html).toContain("Port unavailable");
  expect(html).not.toContain("Stop preview");
  expect(html).not.toContain("<iframe");
});

test("a failed update retains the previous app and permits stopping it", () => {
  const html = renderToStaticMarkup(<LivePreview run={enabledRun} preview={{ ...ready, status: "failed", message: "Install failed" }} busy={false} onConfigure={async () => true} />);
  expect(html).toContain("Your previous preview is still available");
  expect(html).toContain("Restart preview");
  expect(html).toContain("Stop preview");
  expect(html).toContain("Install failed");
  expect(html).toContain("<iframe");
});
