# S-D4 — Incident lifecycle and status

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-D3 · **Size:** M

## Story
As a reader, I want an incident's status to reflect what the data actually supports, so
that I can tell active events from finished ones without the system inventing certainty.

## Acceptance criteria
- [ ] Statuses: `reported`, `dispatched`, `active`, `contained`, `resolved`, `unknown` (PRD §9/§19).
- [ ] Transitions are driven by **the agency's own timestamps**, verified present 2026-09-17: `received_datetime` → `reported`; `dispatch_datetime`/`enroute_datetime` (100% fill) → `dispatched`; `onscene_datetime` (84%) → `active`; `close_datetime` + `disposition` (83%/75%) → `resolved`.
- [ ] `disposition` maps to a resolution reason via config: `GOA`/`UTL`/`NOM`/`ND` → nothing-found (~20% of calls), `REP` → report taken, `CIT`/`ARR` → enforcement, `HAN`/`ADV` → handled.
- [ ] Staleness inference is the **fallback for the ~17% of calls with no `close_datetime`**, not the primary mechanism: no new observation for a configurable per-type interval (default 45 min, fire 3 h) moves the incident to `unknown`, **never** to `resolved`.
- [ ] Status never regresses except via an explicit corrective source record (S-D7), and every change writes a timeline entry with its source.
- [ ] `resolvedAt` is set only from an explicit source signal.
- [ ] State machine is a pure function `(currentStatus, observation) → nextStatus + reason`, exhaustively unit-tested.
- [ ] Staleness sweep runs as a scheduled job and is idempotent.

## Out of scope
Severity (S-D6).
