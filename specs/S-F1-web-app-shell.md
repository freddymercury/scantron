# S-F1 — Web app shell and layout

**Epic:** F · Web · **Phase:** 1 · **Depends on:** S-E2 · **Size:** M

## Story
As a reader, I want a responsive three-pane layout (feed, map, detail), so that the whole
city view fits one screen on desktop and degrades sensibly on a phone.

**Reference:** `mockups/index.html`.

## Acceptance criteria
- [ ] Desktop (≥1100 px): feed / map / detail in a single non-scrolling page frame, each pane scrolling independently.
- [ ] Tablet: feed + map, detail opens as an overlay panel.
- [ ] Mobile: feed by default with a map toggle; detail is a full-screen route.
- [ ] Incident selection is URL-addressable (`/i/[id]`), so any view is shareable and deep-linkable.
- [ ] **No Next.js, React or MUI** ([ADR-002](../docs/03-dependency-policy.md)). Server-rendered HTML from `Bun.serve({ routes })` via template-literal components; a hand-written client runtime (~400 lines budget) handles fetch, render, SSE and URL state. `mockups/live.html` is the working proof at 4,484 real incidents.
- [ ] Dark theme per the mockup, with CSS custom properties as the single source of type/spacing/colour tokens. Plain CSS, no preprocessor, no CSS-in-JS.
- [ ] Zero runtime dependencies; no bundler step beyond `Bun.build` for the client file.
- [ ] **Revisit trigger:** if the client runtime exceeds ~1,500 lines, that is the signal to adopt a view library — recorded, not forbidden.
- [ ] Header carries: search field, filter chips, live-connection indicator, and a persistent "preliminary information — call 911 for emergencies" notice reachable from every view.
- [ ] Lighthouse accessibility ≥95: keyboard navigation through feed and filters, focus visible, live-region announcement for new incidents.
- [ ] Server-rendered first paint with real data; no loading-spinner-only initial render.

## Out of scope
Accounts, settings, onboarding.
