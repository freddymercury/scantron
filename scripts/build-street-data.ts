/**
 * `bun run build:street-data` — regenerate `packages/sf-domain/src/street-data.ts` from
 * the city's own records.
 *
 * The street list is data, not code (S-C1), and it is derived rather than remembered:
 * every distinct `intersection_name` in the historical dispatch dataset tells us how San
 * Francisco writes each street.
 */

import { createSocrataClient } from "../services/sf-cad-ingest/src/socrata.ts";

const DATASET = "2zdj-bwza";
const OUTPUT = new URL("../packages/sf-domain/src/street-data.ts", import.meta.url).pathname;

const SUFFIXES: Record<string, string> = {
  ST: "St",
  AVE: "Ave",
  AV: "Ave",
  BLVD: "Blvd",
  DR: "Dr",
  RD: "Rd",
  WAY: "Way",
  WY: "Way",
  LN: "Ln",
  CT: "Ct",
  PL: "Pl",
  TER: "Ter",
  ALY: "Aly",
  HWY: "Hwy",
  CIR: "Cir",
  PLZ: "Plz",
  PARK: "Park",
  EXPY: "Expy",
  STPS: "Stps",
  WALK: "Walk",
  ROW: "Row",
  PATH: "Path",
};

const ORDINAL = /^0*(\d+)(?:ST|ND|RD|TH)$/;

function normalizeBase(base: string): string {
  const match = ORDINAL.exec(base);
  if (!match) return base;
  const n = Number(match[1]);
  const mod100 = n % 100;
  const last = n % 10;
  const suffix =
    mod100 >= 11 && mod100 <= 13 ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

function splitStreet(street: string): { base: string; suffix?: string } {
  const tokens = street.split(/\s+/);
  const last = tokens.at(-1) as string;
  if (tokens.length >= 2 && SUFFIXES[last]) {
    return { base: tokens.slice(0, -1).join(" "), suffix: last };
  }
  return { base: street };
}

const client = createSocrataClient();
const rows = await client.query<{ intersection_name?: string }>({
  dataset: DATASET,
  select: "intersection_name",
  // Socrata's GROUP BY gives us the distinct set without paging millions of rows.
  group: "intersection_name",
  order: "intersection_name",
  limit: 50_000,
});

const names = rows.map((row) => row.intersection_name).filter((name): name is string => Boolean(name));
const counts = new Map<string, Map<string, number>>();
const crossesAvenue = new Map<string, number>();

for (const name of names) {
  const streets = name
    .split("\\")
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed = streets.map(splitStreet);

  for (const { base, suffix } of parsed) {
    if (!suffix) continue;
    const perBase = counts.get(base) ?? new Map<string, number>();
    perBase.set(suffix, (perBase.get(suffix) ?? 0) + 1);
    counts.set(base, perBase);
  }

  const hasNumberedAvenue = parsed.some(({ base, suffix }) => ORDINAL.test(base) && suffix === "AVE");
  if (!hasNumberedAvenue) continue;
  for (const { base } of parsed) {
    if (ORDINAL.test(base)) continue;
    crossesAvenue.set(base, (crossesAvenue.get(base) ?? 0) + 1);
  }
}

const suffixByName: Record<string, string> = {};
const ambiguous: string[] = [];
for (const [base, perBase] of counts) {
  const total = [...perBase.values()].reduce((sum, n) => sum + n, 0);
  const [top, topCount] = [...perBase.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number];
  const key = normalizeBase(base);
  if (topCount / total >= 0.8) suffixByName[key] = SUFFIXES[top] as string;
  else ambiguous.push(key);
}

const cross = [...crossesAvenue.entries()]
  .filter(([, n]) => n >= 5)
  .map(([base]) => normalizeBase(base))
  .sort();

const entries = Object.entries(suffixByName)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, suffix]) => `  ${JSON.stringify(name)}: ${JSON.stringify(suffix)},\n`)
  .join("");

const source = `/**
 * Street data derived from the city's own records, not from memory.
 *
 * Source: every distinct \`intersection_name\` in the historical dispatch dataset
 * (\`${DATASET}\`), fetched ${new Date().toISOString().slice(0, 10)} — ${names.length} intersection strings covering
 * ${counts.size} distinct street names. Regenerate with \`bun run build:street-data\`.
 */

/**
 * Street name → the suffix the city writes for it, where the records agree (>=80% of
 * mentions). Used to complete a name written without one: \`IRVING\` → \`Irving St\`.
 */
export const SF_STREET_SUFFIXES: Readonly<Record<string, string>> = {
${entries}};

/**
 * Names the records write with more than one suffix, so a bare mention is genuinely
 * ambiguous. Numbered streets dominate this list because San Francisco has both a
 * \`19th St\` and a \`19th Ave\`.
 */
export const AMBIGUOUS_STREET_NAMES: readonly string[] = ${JSON.stringify(ambiguous.sort(), null, 2)};

/**
 * Named streets observed crossing the numbered *avenues* (the Richmond and Sunset grid).
 * This is how \`19th and Irving\` resolves to \`19th Ave & Irving St\` rather than \`19th St\`:
 * Irving crosses avenues, so its partner is an avenue.
 */
export const AVENUE_CROSS_STREETS: readonly string[] = ${JSON.stringify(cross, null, 2)};
`;

await Bun.write(OUTPUT, source);
console.log(
  `wrote ${OUTPUT}: ${Object.keys(suffixByName).length} streets, ${ambiguous.length} ambiguous, ${cross.length} avenue cross-streets`,
);
