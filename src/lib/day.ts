// All competition logic runs on UTC calendar days.

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function utcYesterday(d: Date = new Date()): string {
  const y = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  return utcDay(y);
}

/** Champions retire undefeated: one win, ever. A set `last_won_on` is final. */
export function isRetired(wonDay: string | null): boolean {
  return wonDay !== null;
}

/** ms until next 00:00 UTC */
export function msUntilClose(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}
