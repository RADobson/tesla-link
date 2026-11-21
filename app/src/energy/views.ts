import { zonedParts } from "./time";

export interface DayMark {
  label: string;
  self: number;
}

export interface ChargeSession {
  start: number;
  end: number;
  solarKwh: number;
  gridKwh: number;
}

const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Daily self-sufficiency from power samples. Solar energy over house energy, capped at 1. */
export function dayMarks(
  points: { ts: number; solarW: number; homeW: number }[],
  timeZone: string,
): DayMark[] {
  const buckets = new Map<string, { solar: number; home: number; label: string }>();
  const ordered = [...points].sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < ordered.length; i++) {
    const hours = (ordered[i].ts - ordered[i - 1].ts) / 3_600_000;
    if (hours <= 0 || hours > 1) continue;
    const parts = zonedParts(new Date(ordered[i].ts), timeZone);
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    const row = buckets.get(key) ?? {
      solar: 0,
      home: 0,
      label: `${WEEKDAYS[parts.weekday]} ${parts.day}`,
    };
    row.solar += Math.max(0, ordered[i].solarW) * hours;
    row.home += Math.max(0, ordered[i].homeW) * hours;
    buckets.set(key, row);
  }
  return [...buckets.values()].slice(-28).map((row) => ({
    label: row.label,
    self: row.home > 0 ? Math.min(1, row.solar / row.home) : 0,
  }));
}

/** Neighbouring charge slices within the gap are one session. */
export function chargeSessions(
  slices: { ts: number; solarKwh: number; gridKwh: number }[],
  gapMs = 45 * 60 * 1000,
): ChargeSession[] {
  const ordered = [...slices]
    .filter((slice) => slice.solarKwh > 0 || slice.gridKwh > 0)
    .sort((a, b) => a.ts - b.ts);
  const sessions: ChargeSession[] = [];
  for (const slice of ordered) {
    const last = sessions.at(-1);
    if (!last || slice.ts - last.end > gapMs) {
      sessions.push({ start: slice.ts, end: slice.ts, solarKwh: slice.solarKwh, gridKwh: slice.gridKwh });
    } else {
      last.end = slice.ts;
      last.solarKwh += slice.solarKwh;
      last.gridKwh += slice.gridKwh;
    }
  }
  return sessions.slice(-12);
}
