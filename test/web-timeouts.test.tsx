import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_RUN_TIMEOUTS, RUN_TIMEOUT_BOUNDS } from "../src/shared/types.ts";
import { RunTimeoutFields } from "../src/web/components/RunTimeoutFields.tsx";

test("timeout controls show defaults in minutes and use the shared operation bounds", () => {
  const html = renderToStaticMarkup(<RunTimeoutFields value={DEFAULT_RUN_TIMEOUTS} onChange={() => {}} />);
  expect(html).toContain("Agent call (minutes)");
  expect(html).toContain("Check command (minutes)");
  expect(html).toContain(`min="${RUN_TIMEOUT_BOUNDS.agentMinutes.min}" max="${RUN_TIMEOUT_BOUNDS.agentMinutes.max}" step="1" value="45"`);
  expect(html).toContain(`min="${RUN_TIMEOUT_BOUNDS.checkMinutes.min}" max="${RUN_TIMEOUT_BOUNDS.checkMinutes.max}" step="1" value="15"`);
  expect(html).toContain("The total run budget still applies");
});
