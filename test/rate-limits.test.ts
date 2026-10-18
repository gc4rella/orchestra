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
