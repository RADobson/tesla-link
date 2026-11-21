export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const bag: Record<string, string> = {};
  for (const part of format.formatToParts(date)) bag[part.type] = part.value;
  const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    weekday: weekdays[bag.weekday] ?? 1,
  };
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = zonedParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  return asUtc - utcMs;
}

export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone);
}

/** Monday 00:00 in the house timezone, through the following Monday. */
export function weekRange(now: Date, timeZone: string): { start: number; end: number } {
  const parts = zonedParts(now, timeZone);
  const start = zonedTimeToUtc(parts.year, parts.month, parts.day - (parts.weekday - 1), 0, 0, timeZone);
  return { start, end: start + 7 * 24 * 60 * 60 * 1000 };
}
