# A second opinion on correlation — built, measured, not enabled

**Status:** Built, off by default · **Date:** 2026-09-20 · **Relates to:** [S-D2](../specs/S-D2-correlation-scoring.md), [S-D3](../specs/S-D3-merge-decision-and-probable-log.md), [S-D10](../specs/S-D10-correlation-fixture-harness.md)

## The idea

`jev-dispatch` (one of the TypeSafe demos) asks a decision model seven typed questions per
incoming emergency report, one of which is **`duplicate-of-open-incident`**. That is
exactly the question S-D3 answers, so it was worth asking whether a model that reads the
agency's own words could do better than our scorer on the cases the scorer is least sure
about.

There was a concrete reason to expect it might. The harness measured that our type
taxonomy is too coarse in places: PRD §10 deliberately keeps the type list broad, so
`FIGHT NO WEAPON` and `VANDALISM` are both `disturbance`, and only one of them brings an
ambulance. A judge reading "FIGHT NO WEAPON" and "Medical Incident" has information our
affinity matrix has already thrown away.

## What was built

`judgePair` asks one typed question — *is this the same real-world event?* — over five
ordered levels. Constrained hard:

* consulted **only** inside the probable band (0.65–0.85), never on a confident decision;
* may move a decision only *within* that band — promote to merge, or push to a new incident;
* shown exactly what a published record shows: call type, agency, canonical location,
  units, minutes apart, metres apart. No free text, no identifiers, no internal ids;
* deadline-bounded on our side; with no key, a failure or a timeout, correlation behaves
  identically to having no judge at all.

## What it measured

**Live, 24 hours, 1,804 observations:** 124 requests (the probable band is ~7% of pairs),
0 failures, 1 timeout, **$0.00285** — about a dollar a year. It moved 9 decisions: 3
promoted to merges, 6 pushed apart. Reduction 2.9% → 3.1%.

**Against the 155 labelled cases:** F1 0.955 → 0.957. It fixed 1 case and broke 3.

```
FIXED  hand_77  same       FIGHT NO WEAPON + Medical Incident, 7.6 min apart
BROKE  hand_72  different  VANDALISM + Medical Incident, 5.7 min apart
BROKE  hand_89  different  VANDALISM + Medical Incident, 5.4 min apart
BROKE  hand_95  different  SIT/LIE ENFORCEMENT + Medical Incident, 3.8 min apart
```

## The decision: off by default

A +0.001 F1 change is noise, and the changes it made were concentrated on pairs where the
answer is genuinely arguable — a vandalism call and a medical call at one corner five
minutes apart *might* be one event where someone was hurt. Our labels say different; the
judge says same; neither of us can prove it from a record that carries no narrative.

So it ships behind `--judge` on `bun run replay:correlation` and `bun run
eval:correlation`, and correlation runs without it. **Building it was still the right
call** — the alternative was an opinion about whether it would help, and now there is a
number.

## What it is actually good for

The disagreements are the useful output, not the decisions. Every case the judge and the
labels disagree on is a case where the label is weak evidence, which makes it a review
queue: the probable band already logs 124 pairs a day, and a second annotator that
disagrees on 4% of them points at exactly the ones worth a human minute.

## What would change the verdict

Better labels for the probable band. The ground-truth half of the fixture set (one SFFD
call dispatched to two unit types) is scored 45/45 by both the scorer and the judge —
neither is challenged there. The cases that separate them are the hand-labelled ones, and
those are my judgement, not the city's. If a reviewer worked through a few hundred probable
pairs, this measurement could be re-run against labels worth trusting.
