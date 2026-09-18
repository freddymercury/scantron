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
