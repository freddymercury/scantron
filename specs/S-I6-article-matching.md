# S-I6 — Article-to-incident matching

**Epic:** I · Outcome sources · **Phase:** 3 · **Depends on:** S-I4, S-I5 · **Size:** L

## Story
As a reader, I want news coverage shown against the right incident, so that an article
adds context instead of asserting something false about an unrelated event.

## Acceptance criteria
- [ ] Two thresholds, not one. **Confirmed** (default ≥0.93) requires corroborating specifics — an address or intersection plus a time consistent with the incident, or an explicit agency reference. **Possible** (0.75–0.92) attaches but renders as "possibly related coverage."
- [ ] Below the possible threshold, nothing attaches. Unmatched articles are stored and visible internally, never surfaced against an incident.
- [ ] A neighborhood-level-only match ("a fire in the Mission") can never reach **confirmed** — geography alone is not identity.
- [ ] **PII constraint:** an article that names a victim, suspect, or private individual may still be linked, but the product renders only headline, outlet, and time. We never extract, store, or display the named person, and never use article contents to populate an incident field. *An article attachment must not become person-identification by reference* (PRD §5, §30).
- [ ] Every attachment is reversible from the admin UI (S-G3) and reversal is one click, with the rejection recorded as a labelled negative.
- [ ] False-attachment rate is an explicitly tracked metric with a target under 0.5%, reviewed before the feature leaves flag.
- [ ] All attachments are human-reviewable in a queue before public display for the first 90 days of operation.

## Risk note
Precision and recall trade off badly here and there is no comfortable middle. Most local
coverage lacks the specifics needed for a confident match, so high precision means attaching
almost nothing; loosening the threshold means occasionally telling a family the wrong story
about their event. **A wrong article attachment is categorically worse than a duplicate
incident** — it is a false public statement about a real event involving real people. When
in doubt, attach nothing.
