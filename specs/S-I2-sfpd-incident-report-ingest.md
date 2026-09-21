# S-I2 — SFPD incident report ingest and CAD join

**Epic:** I · Outcome sources · **Phase:** 3 · **Depends on:** S-I1, S-B1 · **Size:** M

## Story
As the system, I want SFPD's published incident reports joined to the dispatch records
they came from, so that we learn how a call was actually written up.

**Feasibility check ANSWERED 2026-09-17: `wg3w-h783.cad_number` joins to
`gnap-fj3t.cad_number`, ~100% coverage for dispatched reports.** The deterministic branch is
the real one. But see the revised reality check — this mostly moves the story's value into
S-I3.

## Acceptance criteria
- [ ] Poller ingests the DataSF Police Department Incident Reports dataset into Observations with `source = "sf_police_report"`, on a slow schedule (hourly is ample — this data lags days).
- [ ] **If a CAD number is present:** deterministic join to the originating observation; no fuzzy matching, no scoring, confidence 1.0. Unjoinable reports are stored and counted, never guessed at.
- [ ] The join is **one-to-many** — 1.71 report rows per CAD number (multiple offence rows per call). Attaching reports must deduplicate on `cad_number`; counting report rows as incidents inflates by ~70%.
- [ ] Reports with no `cad_number` (online-filed Coplogic reports and supplements, ~11%) are stored unjoined and never fuzzy-matched.
- [ ] Report disposition and offense classification map into the existing taxonomy (S-A4) and drive an S-D7 correction where they disagree with the dispatch classification.
- [ ] **Person-level fields are dropped at the adapter** — no names, no suspect descriptions, no arrest detail, no demographic fields — with a counter for what was discarded. This is a hard constraint, not a default (PRD §5).
- [ ] Join rate and lag are metrics: what share of dispatch incidents ever receive a report, and how long it takes.
- [ ] Reports arriving for an incident outside the retention/publication window still attach; a closed incident is not immutable to outcomes.

## Reality check — revised 2026-09-17
Publication lag is **median 2 days, p90 3.8 days** — better than the "days to weeks" I
assumed, still far past when anyone is looking at the incident page.

**The bigger correction: `disposition` is already in the real-time dispatch feed at 75%
fill.** Basic outcomes — arrest, cite, gone on arrival, unfounded, no merit — need no report
join at all and are available in Phase 0. What the report dataset adds beyond that is the
*offence classification* and the labelled corpus in S-I3. The consumer-facing case for this
story is much weaker than it looked; the internal case is much stronger.

## Decision (recorded 2026-09-21)

Built and running. 781 reports ingested on the first cycle, **532 joined (68.1%)**, 120
unjoinable (no `cad_number`), 129 with a `cad_number` for a call outside our dispatch
window. The 68% is not the join rate the feasibility check predicted, and the gap is
explained rather than mysterious: this system holds five months of dispatch data, SFPD
republishes reports for incidents going back years, and a report for a 2020 call has
nothing here to join to. Of reports whose call we actually hold, the join is deterministic
and total.

**A report is not a call.** That distinction is enforced in four places rather than
remembered:

- `DISPATCH_SOURCES` in `@scantron/incident-schema` is what "how many calls" means, and
  the ask box, the corner history and the source-span note all filter to it.
- `source_count` excludes reports; `independent_source_count` counts distinct *agencies*,
  so SFPD's paperwork for an SFPD call can never raise corroboration.
- The incident page plots calls on the map and lists reports separately.
- Reports never reach the scorer. `joinReport` is a lookup on `cad_number` at confidence
  1.0, and a report with no `cad_number` is stored, counted and left alone — guessing which
  incident an online-filed report belongs to would attach a stranger's report to somebody
  else's event.

**The allowlist is the safety property.** `KEPT_FIELDS` enumerates all 28 keys the dataset
publishes; anything else is dropped and counted by name. SFPD publishes no person-level
fields here today — the point is that the default is drop, so a new field cannot ride into
storage silently.

### Two things this cost

Migration 014 rebuilds `observations` to widen its `source` CHECK constraint, which SQLite
cannot alter in place. That surfaced a real gap in the migration runner: SQLite's own
table-rebuild recipe needs `foreign_keys = OFF` *outside* the transaction, because dropping
a parent table with live children is a violation and the pragma is a no-op once a
transaction is open. The runner now does that around every migration and runs
`foreign_key_check` immediately after, so the escape hatch cannot become a loophole.

Report observations do not get a `type`. The adapter maps `incident_category` onto the
taxonomy (93.0% of 300 live rows), but `type` is a DERIVED column owned by normalization
(S-B3), so the adapter's value is dropped on write and the normalizer has no mapping for
`incident_code`. It costs nothing today — the incident page reads the category from
metadata, and reports are excluded from type breakdowns — but S-I3 wants these typed, so
the taxonomy needs `incident_category` entries.
