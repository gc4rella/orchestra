import { expect, test } from 'bun:test';
import { rateLimitRetryAt } from '../src/server/rate-limits.ts';

const now = Date.parse('2026-10-18T15:50:02Z');
test('Claude session limit uses the provider timezone and waits past reset', () => {
  expect(rateLimitRetryAt("success: You've hit your session limit · resets 9:40pm (Europe/Rome)", now)).toBe(Date.parse('2026-10-18T19:41:00Z'));
});
test('reset clock crosses midnight and respects daylight saving', () => {
  expect(rateLimitRetryAt("You've hit your session limit · resets 1am (Europe/Rome)", now)).toBe(Date.parse('2026-10-18T23:01:00Z'));
});
test('relative delay and bounded fallback; unrelated errors are ignored', () => {
  expect(rateLimitRetryAt('Rate limit reached. Try again in 1h 2m 3s', now)).toBe(now + 3783_000);
  expect(rateLimitRetryAt('rate_limit_exceeded', now)).toBe(now + 900_000);
  expect(rateLimitRetryAt("You've hit your session limit · resets 9pm (Invalid/Zone)", now)).toBe(now + 900_000);
  expect(rateLimitRetryAt('Invalid API key', now)).toBeNull();
});

import { parseQuota } from '../src/server/runtimes.ts';

test('Codex windows are classified by duration, including weekly-only subscriptions', () => {
  expect(parseQuota('codex', { rateLimits: { primary: { usedPercent: 57, windowDurationMins: 10080, resetsAt: 1800000000 } } }))
    .toEqual([{ window: 'weekly', usedPercent: 57, resetsAt: 1800000000000 }]);
  expect(parseQuota('codex', { rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1800000000 },
    secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: 1800001000 },
  } } })).toHaveLength(2);
});

test('Claude subscription quota uses provider percentages and reset dates', () => {
  expect(parseQuota('claude-code', { five_hour: { utilization: 49, resets_at: '2026-10-18T20:00:00Z' }, seven_day: null }))
    .toEqual([{ window: '5h', usedPercent: 49, resetsAt: Date.parse('2026-10-18T20:00:00Z') }]);
});

test('unknown, missing, and invalid quota never become a fabricated full allowance', () => {
  expect(parseQuota('codex', { rateLimits: { primary: { usedPercent: '0', windowDurationMins: 300, resetsAt: 1800000000 } } })).toEqual([]);
  expect(parseQuota('claude-code', { five_hour: { utilization: 0, resets_at: 'invalid' } })).toEqual([]);
  expect(parseQuota('codex', {})).toEqual([]);
  expect(parseQuota('codex', { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 15, resetsAt: 1800000000 } } })).toEqual([]);
});
