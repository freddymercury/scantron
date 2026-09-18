/**
 * DataSF timestamps arrive *naive* — `2026-09-17T09:02:03.000`, no zone — and they are San
 * Francisco local time. Reading them as UTC would shift every record by 7 or 8 hours and,
 * worse, would do it inconsistently across a DST boundary.
 *
 * ADR-002 rules out a date library, and none is needed: `Intl.DateTimeFormat` already
 * knows the zone rules, so the offset can be derived for any instant.
 */

export const SF_TIMEZONE = "America/Los_Angeles";

const FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: SF_TIMEZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Milliseconds to add to a UTC instant to get San Francisco wall-clock time. */
export function pacificOffsetMs(instant: Date): number {
  const parts = Object.fromEntries(
    FORMATTER.formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;

  const asUtc = Date.UTC(
    parts.year as number,
    (parts.month as number) - 1,
    parts.day as number,
    // Intl renders midnight as 24 in some ICU versions.
    (parts.hour as number) % 24,
    parts.minute as number,
    parts.second as number,
  );
  return asUtc - instant.getTime();
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

/**
 * Parse a DataSF timestamp into a real instant.
 *
 * A naive timestamp is read as San Francisco local time; one that carries a zone (`Z` or
 * an offset) is trusted as-is. Returns `undefined` rather than an Invalid Date, so a
 * malformed row is a quarantine decision rather than a NaN that spreads.
 */
export function parseSfTimestamp(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  const naive = NAIVE.exec(trimmed);
  if (!naive) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  const [, year, month, day, hour, minute, second, millis] = naive as unknown as string[];
  const asIfUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number((millis ?? "0").padEnd(3, "0")),
  );

  // Two passes: the offset depends on the instant, and the instant depends on the offset.
  // The first guess is wrong only within an hour of a DST change; the second pass fixes it.
  let instant = asIfUtc - pacificOffsetMs(new Date(asIfUtc));
  instant = asIfUtc - pacificOffsetMs(new Date(instant));
  return new Date(instant);
}

/** The inverse: an instant rendered as the naive local string DataSF would have written. */
export function toSfNaiveString(instant: Date): string {
  const shifted = new Date(instant.getTime() + pacificOffsetMs(instant));
  return shifted.toISOString().replace("Z", "").replace(/\.\d{3}$/, ".000");
}
