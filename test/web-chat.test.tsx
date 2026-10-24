import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DirectorChatTurn, Run } from "../src/shared/types.ts";
import { DirectorChat, mergeChatTurns } from "../src/web/components/DirectorChat.tsx";

test("late history and POST responses cannot replace a completed live reply with pending state", () => {
  const pending: DirectorChatTurn = { id: 1, runId: "run", text: "Question", reply: "", status: "pending", error: null, createdAt: 1 };
  const completed: DirectorChatTurn = { ...pending, reply: "Answer", status: "completed" };
  expect(mergeChatTurns([completed], [pending])).toEqual([completed]);
  expect(mergeChatTurns([pending], [completed])).toEqual([completed]);
  expect(mergeChatTurns([completed], [{ ...pending, id: 2 }])).toEqual([completed, { ...pending, id: 2 }]);
});

test("side chat has a labeled composer and explains that chatting does not start or resume work", () => {
  const html = renderToStaticMarkup(<DirectorChat run={{ id: "run", status: "completed" } as Run} director="Boss" open onClose={() => {}} />);
  expect(html).toContain('aria-label="Chat with the Director"');
  expect(html).toContain('aria-label="Close Director chat"');
  expect(html).toContain('for="director-question"');
  expect(html).toContain("without starting or resuming work");
  expect(html).toContain('type="submit" disabled=""');
});
