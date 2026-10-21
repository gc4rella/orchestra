import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Run } from "../src/shared/types.ts";
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
