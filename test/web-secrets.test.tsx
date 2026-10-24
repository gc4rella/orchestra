import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SecretRow, Secrets } from "../src/web/components/Secrets.tsx";

test("secrets start closed; rows render masked values with explicit reveal and copy controls", () => {
  const panel = renderToStaticMarkup(<Secrets runId="one" visible previewEnabled onRestart={async () => true} />);
  expect(panel).toContain("Open secrets");
  expect(panel).not.toContain("secret-form");
  const row = renderToStaticMarkup(<SecretRow secret={{ name: "ADMIN_PASSWORD", environment: true, source: "saved", commit: null, updatedAt: 1 }} endpoint="/api/runs/one/secrets" busy={false} onDelete={() => {}} onEdit={() => {}} />);
  expect(row).toContain('aria-label="ADMIN_PASSWORD hidden"');
  expect(row).toContain("••••••••");
  expect(row).toContain("Reveal");
  expect(row).toContain("Copy");
  expect(row).toContain("Environment variable · project");
});
