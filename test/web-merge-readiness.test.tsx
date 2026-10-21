import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Run } from "../src/shared/types.ts";
import { MergeReadiness } from "../src/web/components/MergeReadiness.tsx";

test("an older running server offers restart guidance instead of an unavailable merge check", () => {
  const html = renderToStaticMarkup(<MergeReadiness run={{ id: "old-run", acceptedCommit: "checked-revision" } as Run} />);
  expect(html).toContain("Local merge checks require a newer Orchestra server");
  expect(html).toContain("Restart Orchestra after active runs have stopped");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<input");
});
