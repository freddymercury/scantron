# S-C1 — Location text normalization

**Epic:** C · Normalization · **Phase:** 0 · **Depends on:** S-A3 · **Size:** L

## Story
As the system, I want the many written forms of an SF location parsed into one canonical
structure, so that two agencies describing the same corner produce the same string.

## Acceptance criteria
- [ ] `normalizeLocation(raw: string)` returns `{ kind: 'intersection'|'address'|'block'|'landmark'|'unknown', canonical, streets[], addressNumber?, confidence }`.
- [ ] All of `19TH AV/IRVING ST`, `19th and Irving`, `IRVING / 19TH`, `19TH AVE AT IRVING` normalize to `19th Ave & Irving St` (PRD §16) — cross-street order is canonicalized deterministically.
- [ ] Handles: ordinal avenues, `ST/AVE/BLVD/WAY/TER/HWY` suffix expansion, block ranges (`2300 BLOCK OF MISSION ST` → block kind, number 2300), directional prefixes, and `&`/`/`/`AT`/`AND` separators.
- [ ] SF-specific names resolve correctly, including `O'Shaughnessy`, `Cesar Chavez` (and `Army St`), `3rd St`/`Third St`, `Great Highway`, `The Embarcadero`, `Brotherhood Way`, `Portola Dr`.
- [ ] Street name list and alias table live in `packages/sf-domain` as data, not code.
- [ ] Unparseable input returns `kind: 'unknown'` with the raw string preserved and confidence 0 — never a guess.
- [ ] A ≥200-case fixture suite drawn from real observed strings passes; each new parse bug adds a case.

## Out of scope
Coordinates and neighborhoods (S-C2); transcript locations (Phase 2).
