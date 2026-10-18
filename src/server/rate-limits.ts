/** A failed CLI response indicating provider throttling, never an ordinary agent answer. */
export function rateLimitRetryAt(message: string, now: number): number | null {
  if (!/(?:you(?:'|’)ve hit your (?:session|usage|weekly) limit|rate[_ -]?limit|usage limit (?:reached|exceeded)|too many requests)/i.test(message)) return null;
  const relative = message.match(/(?:try again|retry|resets?)\s+(?:in|after)\s+(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?/i);
  if (relative && relative.slice(1).some(Boolean)) {
    return now + (Number(relative[1] ?? 0) * 3600 + Number(relative[2] ?? 0) * 60 + Number(relative[3] ?? 0) + 60) * 1000;
  }
  const clock = message.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    if (clock[3]) hour = hour % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
    if (hour <= 23 && minute <= 59) {
      try {
        const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: clock[4], hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const target = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        // Search UTC minutes to respect the provider's zone, including daylight-saving changes.
        for (let time = Math.floor(now / 60_000) * 60_000; time < now + 26 * 3600_000; time += 60_000) {
          if (formatter.format(time) === target) return time + 60_000;
        }
      } catch { /* Unknown zone: use the bounded fallback retry. */ }
    }
  }
  return now + 15 * 60_000;
}
