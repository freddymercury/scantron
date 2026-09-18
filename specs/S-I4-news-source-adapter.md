# S-I4 — News source adapter

**Epic:** I · Outcome sources · **Phase:** 3 · **Depends on:** S-I1 · **Size:** M

## Story
As the system, I want local news coverage ingested as Observations, so that articles can be
matched to the incidents they describe.

## Acceptance criteria
- [ ] RSS/Atom adapters for SF outlets (Chronicle, SF Standard, Mission Local, KQED, ABC7, SFGate), configured per outlet in `source_configuration`, polled every 10–15 minutes.
- [ ] **Link-only storage:** URL, headline, publisher, publish time, author, and at most a short excerpt. No full article text is stored or rendered. Storage limits are enforced in code, not by convention.
- [ ] Articles enter as Observations with `source = "news"` and `visibility` defaulting to `public`, but they never contribute to incident counts, digests (S-H2), or rollups (S-H6) — an article is not an event.
- [ ] Location and time entities extracted from headline and excerpt only, with explicit confidence; an article with no extractable location is stored unmatched rather than guessed at.
- [ ] `robots.txt` and per-outlet terms are respected; a documented per-outlet record states what we store and on what basis, reviewed before launch.
- [ ] Outlet attribution and a clickthrough link are mandatory on any rendered article.
- [ ] Articles never write into incident fields — not title, type, severity, or summary. They attach, and that is all.

## Reality check
Local news covers on the order of 5–15 incidents a day against ~1,500–2,500 dispatch calls.
Expect an attachment rate near **0.5%**. This feature is blank on 99% of incident pages by
design — see S-I7.
