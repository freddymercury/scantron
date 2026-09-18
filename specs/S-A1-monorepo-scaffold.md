# S-A1 — Monorepo scaffold

**Epic:** A · Foundation · **Phase:** 0 · **Depends on:** — · **Size:** S

## Story
As an engineer, I want a Bun workspace monorepo with the package layout from PRD §35,
so that services and packages can be added without restructuring later.

## Acceptance criteria
- [ ] `bun install` at the root installs all workspaces; `apps/*`, `services/*`, `packages/*` are workspace globs.
- [ ] Packages exist as stubs with `package.json`, `tsconfig.json`, and a passing `bun test`: `incident-schema`, `location-normalizer`, `sf-domain`, `event-taxonomy`, `database`, `observability`.
- [ ] `services/sf-cad-ingest`, `services/incident-correlator` exist as runnable no-op processes; `apps/web` is a Next.js App Router app that boots.
- [ ] Root scripts: `bun run typecheck`, `bun run test`, `bun run lint`, `bun run dev` (web + worker together).
- [ ] Shared base `tsconfig` with `strict: true` and path aliases (`@lescan/*`) resolving across workspaces.
- [ ] CI runs typecheck + test on every push and fails the build on either.

## Technical notes
Bun >= 1.4. One `.env.example` at root documenting every variable any workspace reads.
No service imports another service; shared code goes in `packages/`.

## Out of scope
Deployment, Dockerfiles, preview environments.
