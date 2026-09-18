# Data source findings — verified 2026-09-17

Checked live against the DataSF APIs, not from memory. Sample: 2,000 most recent incident
reports, 1,000 most recent dispatched calls.

**Host note:** `data.sfgov.org` 301-redirects to `data.sf.gov`. Use the latter directly.

## 1. The CAD join exists and works ✅

| Dataset | ID | Key field |
|---|---|---|
| Police Department Incident Reports | `wg3w-h783` | `cad_number` |
| Law Enforcement Dispatched Calls (Real-Time) | `gnap-fj3t` | `cad_number` |

- `cad_number` present on **88.7%** of report rows (1,774/2,000).
- Every missing one is explained: **183 `filed_online` (Coplogic self-service) + 43 supplements = 226**, exactly the gap. **For dispatched incidents, CAD coverage is effectively 100%.**
- Live join test: 60 report CAD numbers → 33 matched in the real-time dispatch feed. The misses are the online/supplement rows plus the real-time feed's retention window.
- **The join is one-to-many: 2,000 report rows → 1,169 distinct CAD numbers (1.71 rows per call).** One call yields multiple offense rows (e.g. Warrant + Traffic Violation Arrest on one CAD number). Any count of "incidents" from this dataset must deduplicate on `cad_number` or it inflates by ~70%.
- Report publication lag: **median 2.0 days, p90 3.8 days, max 8.9 days.**

## 2. The dispatch feed already carries lifecycle timestamps ⚠️ contradicts assumption 6

Fill rates over 1,000 recent calls:

| Field | Fill |
|---|---|
| `dispatch_datetime` | 100% |
| `enroute_datetime` | 100% |
| `onscene_datetime` | 84.0% |
| `close_datetime` | 83.3% |
| `disposition` | 75.1% |
| `intersection_name` | 64.8% |
| `intersection_point` | 63.4% |
| `analysis_neighborhood` | 63.4% |
| `call_type_original` / `_final`, `priority_original` / `_final` | 100% |
| `sensitive_call` | 100% |

**Assumption 6 was wrong.** There is a reliable close signal: `close_datetime` plus a
disposition code. `S-D4` does not need to infer resolution from staleness for 83% of calls
— staleness inference becomes the fallback, not the mechanism.

Timeline (`S-D5`) gets real agency timestamps — received → dispatched → enroute → onscene →
closed — instead of ingest-time approximations.

Observed dispositions: `HAN` handled (268), `CIT` cite (126), `GOA` gone on arrival (84),
`ADV` advised (73), `REP` report taken (47), `UTL` unable to locate (42), `ND` (39),
`NOM` no merit (32), `ARR` arrest (16), null (249).
**~20% of calls resolve to explicitly-nothing-found** (GOA + UTL + NOM + ND).

## 3. `sensitive_call` is a first-class field 🎯 strengthens S-E1

**35.2%** of calls are flagged `sensitive_call = True` by SFPD itself. This is a
ready-made input to the visibility policy in `S-E1` — we do not have to derive sensitivity
from call-type keywords alone. It should be treated as authoritative and restrictive by
default.

## 4. Corrections are real and measurable ✅ justifies S-D7

`call_type_original != call_type_final` on **4.1%** of calls (41/1000), and priority has the
same original/final split. The shots-fired → fireworks case is not hypothetical; it is ~1 in
25 calls, natively expressed in the source schema.

## 5. "Real-Time" is a batch feed ~30 minutes behind 🚨 MEASURED — breaks PRD §41

I assumed this feed was near-real-time. **It is not.** Measured directly by polling every 20 s
for 5 minutes and timestamping first appearance of each new `cad_number`:

```
24 new records observed — ALL arrived in ONE batch at 22:53:17,
after 14 consecutive empty polls (22:48:28 → 22:52:57)

  min      23.9 min
  median   36.7 min
  p90     128.0 min
  max     234.5 min   (3.9 hours)

  under 30 SECONDS (PRD §41 target):   0 / 24
  under 5 minutes:                     0 / 24
  under 30 minutes:                   11 / 24
```

Corroborating evidence: `data_as_of` is a **single stamp shared by all 4,070 rows**, i.e. the
dataset is republished wholesale on an interval rather than streamed.

### What this breaks

**PRD §41's "source record available → public incident update, target < 30 seconds" is
unachievable from this source, by roughly two orders of magnitude.** No amount of polling
frequency, queue tuning, or language choice changes it — the data does not exist upstream
until ~24+ minutes after the call. A 15 s poll interval mostly re-fetches an unchanged
snapshot.

### What this means for the product

- **Our own latency budget is the only part we control**, and it is now a rounding error next
  to a 24-minute floor. Optimizing ingest-to-publish below a few seconds has no user-visible
  effect.
- **The publication delay in S-E1 (+3 min default) is nearly free** — the data is already
  ~30 minutes old. The safety argument for delay costs almost nothing in freshness.
- **"Live" framing needs to change.** A `live · SSE connected` indicator over data that is
  half an hour old is misleading. The UI should state source freshness explicitly (S-E2
  already returns per-source freshness — it now needs to be *displayed*, not just available).
- **SSE is still right**, but for incident *updates and corrections* over a long tail, not for
  second-by-second liveness.
- This does not invalidate the product. It does invalidate "a real-time scanner". The honest
  claim is **a structured, corrected, cross-agency view of recent city activity**, which is
  the more defensible product anyway (PRD §57).

### Caveat on this measurement
One refresh cycle observed in a 5-minute window. The *interval* is bounded below by ~5 min but
not pinned; the *latency* figures are direct observations. Re-run over several hours before
setting a hard SLO.

## 6. Geocoding is ~63% solved upstream ⚠️ refines assumptions 13–14

`intersection_point` and `analysis_neighborhood` arrive pre-populated on ~63% of calls. The
`location-normalizer` work in `S-C1`/`S-C2` is still needed — but for **the remaining 37%**,
not for all traffic. Use the supplied point and neighborhood when present; that is a
meaningful reduction in scope and risk for two of the larger Phase 0 stories.

## 7. `$offset` paging silently loses and duplicates rows ⚠️ found while building S-B1

Measured 2026-09-18 against `gnap-fj3t`, two consecutive full scans of the same ~4,078-row
window, seconds apart:

| Paging | Fetched | Distinct written | Duplicates | Missed |
|---|---|---|---|---|
| `$order=data_loaded_at ASC` + `$limit`/`$offset` | 4,078 | 4,077 | 12 | 11 |
| Keyset on `(data_loaded_at, id)` | 4,078 | 4,078 | 0 | 0 |

Two causes, both structural rather than intermittent:

1. **Thousands of rows share one `data_loaded_at`** — it is a batch publication timestamp,
   not a per-row one — so ordering by it alone is not a total order, and the database is
   free to return tied rows in a different order on each request.
2. Rows published mid-scan shift every later page, so an offset window steps over records.

The misses are the dangerous half: duplicates are caught by the idempotency key, but a
skipped record is simply never seen, and the gap is invisible without S-B5's detection.

**Page by keyset — `(time > t) OR (time = t AND id > i)` — never by offset**, on any DataSF
feed. Applies equally to S-B2 and to the historical backfill in S-B5.

## 8. SFPD publishes no location at all for sensitive calls 🎯 found while building S-C2

Measured 2026-09-18 over 4,082 live dispatch records:

| Records | Location text | Located |
|---|---|---|
| Not `sensitive_call` (2,787) | 100% | **98.7%** |
| `sensitive_call` (1,295) | **0%** | 0% |

**Every single unresolved observation was a sensitive call**, and every sensitive call
arrived with no `intersection_name`, no `intersection_point` and no
`analysis_neighborhood`. This is not a gap in our geocoding; it is SFPD's own suppression,
applied before publication. (A further 37 non-sensitive records carry the literal string
`Not Available`.)

Three consequences:

1. **S-C2's ">=90% of a sample resolves to coordinates" is unreachable as an overall
   number, and reaching it would mean something had gone wrong.** The rate that measures
   our work is over records that came with a location: 98.7%. `bun run report:geocoding`
   reports both.
2. **~32% of police calls can never appear on a map**, from any amount of engineering.
   Feed and search must not treat a missing point as a defect, and the UI should not imply
   the city is quieter in places where sensitive calls cluster.
3. **S-E1 gets easier and harder.** Easier: the most sensitive third is already stripped of
   location upstream. Harder: `sensitive_call` now correlates perfectly with "no location",
   so publishing *anything* location-shaped about such a call is a red flag to check for.

## 9. Correlation works, and reduces almost nothing ⚠️ the central hypothesis, measured

First run of the real correlator over 24 hours of live data, 2026-09-18, after the
evaluation harness (S-D10) corrected three faults in it:

```
observations   2,137
incidents      2,067
reduction        3.3%
merged             70
probable          128   (logged, not merged)
cross-agency       30 incidents
multi-source       60 incidents
```

An earlier run reported 4.5% — that number was inflated by a bug the harness found, in
which an incident's *activity span* was taken from the row's last-modified time rather than
the last time the event was reported, so every incident looked as though it were still
happening now and time scored a perfect 1.0 against it. The corrected number is lower. It
is also the real one.

The merges it does make are right. Verified by eye across the cross-agency ones:

```
22:38:50  sf_fire_cad  Traffic Collision   → collision  @ Alert Aly & Dolores St     1.000
00:18:53  sf_police    INJURY VEH ACCIDENT → collision  @ North Point St & Taylor St 1.000
23:53:49  sf_ems_cad   Medical Incident    → collision  @ Alemany Blvd & Harrington  0.963
23:57:54  sf_ems_cad   Medical Incident    → assault    @ 6th St & Natoma St         0.886
```

**But 96.7% of observations still become their own incident**, which is what docs/05
warned about: with police and fire CAD alone there is little cross-agency overlap to
exploit. The signal reduction that justifies the product (PRD §54) is not there yet.

Two things this run established that are worth keeping:

1. **Renormalization was necessary and is sufficient.** Flat weights produced 0 merges from
   812 observations; renormalized scoring produced 69 from 2,130, of which 25 are
   cross-agency. The mechanism works — there is simply less overlap in the data than the
   product assumed.
2. **The probable band is where the evidence is.** 166 logged near misses is a far richer
   tuning corpus than 69 merges, and it is the right place to look before moving a
   threshold. S-D10 should score against these, not against the merges.

The honest framing, unchanged from docs/05: if the merge rate stays near this after tuning,
the product needs more sources (S-I2's incident reports, S-I4's news adapter) or a different
claim — and it is much better to know that at issue 19 than at issue 50.
