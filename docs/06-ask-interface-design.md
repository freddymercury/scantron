# Ask interface design — and where a model is allowed to sit

**Status:** Decided · **Date:** 2026-09-18 · **Implements:** [S-H4](../specs/S-H4-ask-interface.md)

Someone types *"most interesting thing in the last 90 minutes in the Mission"* or *"all the
car break-ins in the last 2 weeks in SoMa"* and gets an answer. This note records how that
works, and — more usefully — where a language model is and is not permitted to be.

## The shape

```
question text
  → parse (deterministic grammar)        AskQuery { intent, area, windowMinutes, types, rawCodes }
  → validate (allowlist schema)          the only surface a model could ever write to
  → run (plain SQL)                      our code, always
  → render (templates over fields)       every sentence the reader sees
```

**No free-text model output is ever shown to a reader.** That is the same constraint as
PRD §21, and it is the point of the design rather than a limitation of it. A dispatch code
is a report that something was called in; prose generated from it invites claims about harm,
cause and safety that the data cannot support.

## Applying the 12-factor agents principles

Source: [humanlayer/12-factor-agents](https://github.com/humanlayer/12-factor-agents)
(`content/factor-NN-*.md`; cite the zero-padded slugs — the unpadded ones are legacy
redirects). Where the factors are quoted below, they are quoted; the rest is our reading.

**Factor 1 — Natural Language to Tool Calls.** This is the feature's premise: a phrase
becomes a structured object, and deterministic code picks up the payload. The factor's own
caveat matters here — the real-world version resolves proper identifiers first. Our
analogue is vocabulary: a question never free-texts an area or a category, it *selects*
from the city's 41 Analysis Neighborhood names and our taxonomy of types, and anything that
does not resolve is reported as unresolved rather than approximated.

**Factor 4 — Tools are just structured outputs.** The load-bearing one. "The LLM decides
what to do, but your code controls how it's done." `AskQuery` is the entire output surface:
one validated object, no prose, no query the model gets to run itself. `ask/schema.ts` is
that gate, and it uses the allowlist validator from `@scantron/incident-schema`, so a field
a model invents — an `answerText`, say — is dropped rather than carried. A test asserts
exactly that.

**Factor 10 — Small, Focused Agents.** One step, one object, no loop. This is the argument
against the ask box ever growing into a conversational assistant: "as context grows, LLMs
are more likely to get lost or lose focus", and there is no context here to grow.

**Factor 12 — Make your agent a stateless reducer.** `parseQuestion(text, vocabulary)` is a
pure function, and a Tier 2 would be single-shot and equally pure. **Design invariant: the
ask box holds no session state.** A follow-up question is a new question.

**Factors 2 and 3 — Own your prompts / own your context window.** If Tier 2 ships, its
prompt is a versioned file in this repo, not a framework's config, and its context is
deliberately assembled — the area and category vocabularies, today's date so "last 90
minutes" resolves, and a handful of question→JSON examples. Nothing accumulates, which is
Factor 3's ideal case for free.

**Factor 9 — Compact Errors into Context Window,** adapted. The factor's retry loop assumes
a multi-turn agent. For single-shot parsing the equivalent is: validate the emitted JSON,
and on failure re-ask **once** with the validation error appended, then fall back to Tier
1's best guess or the unmatched state. One retry, not the factor's ~3, because a parse that
fails twice is a grammar gap and should be visible as one.

**Explicitly out of scope, so nobody asks:** Factors 5 and 6 (unified execution state,
launch/pause/resume) have nothing to persist in a single-shot parser. Factor 7 (contact
humans with tool calls) is inverted — the human initiates, and our no-prose rule is the
stronger constraint. Factor 11 (trigger from anywhere) is a real future: the same
`AskQuery` would serve an API or an alert rule unchanged.

## Is this "agent work"?

Tier 1 is not. It is a grammar, and it is deterministic on purpose: testable, instant, free,
and it keeps working when a model endpoint does not. Tier 2 would be the smallest possible
agent — one constrained emission of the same object Tier 1 emits — which is why both tiers
can be run over the same corpus of questions and diffed. That diff is the coverage map for
where the grammar needs extending, and it keeps Tier 2 from ever becoming load-bearing for
questions Tier 1 already answers.

## Where Jev sits

A second model shape turned up that the tiered design did not anticipate: **Jev**
(TypeSafe `systemone`), whose output modality is *decisions*, not text. You send a JSON
state and a set of typed questions — a `score` over ordered levels, a `choice` from an enum
you supply, a boolean — and it answers with probability distributions, fast enough
(~150 ms for a 35-question fan-out, per its own demos) to ride along with a keystroke.

That makes it admissible here in a way a text model is not, and the reason is worth being
precise about: **Jev cannot emit a sentence a reader sees, because sentences are not in its
output alphabet.** The Factor 4 boundary this codebase enforces with a validator is
enforced by the protocol instead. It is used for one job — ordering search results — and it
is shown only what a *published* record would show: what the agency called it, where,
which units, when. No source free-text, no raw payload, no agency record ids. A test
asserts that list of fields exactly.

Search is two passes, and the first is the one that has to work:

1. **Lexical retrieval, local.** SQLite FTS5 over what the agency called each call, where
   it happened, and which units went. Sub-millisecond, zero dependencies, always on.
2. **Semantic re-rank, optional.** One fan-out request scoring each candidate against the
   question, plus three query-level questions. Gated by confidence — below the gate an
   answer changes nothing rather than being half-applied — and bounded by a deadline
   enforced on our side, not the provider's. **A late answer is dropped**, because a
   re-rank that lands after the reader has moved on reorders results they were already
   reading.

With no `JEV_API_KEY` the second pass does not happen and search is lexical, which the UI
says in those words rather than pretending the ordering was semantic.

### Measured, 2026-09-18, live through OpenRouter

Routed via `https://openrouter.ai/api/alpha/decisions` — a `chat/completions` call is
rejected outright ("is a decisions model and cannot be used with the chat/completions
endpoint"), which is a pleasing way for an API to enforce the same boundary this codebase
cares about. Resolved model: `typesafe/jev-1.13-20260917`.

| Candidates | p50 | p90 | Input tokens | $ per 1,000 searches |
|---|---|---|---|---|
| 10 | 253 ms | 464 ms | 3,202 | $0.134 |
| 20 | 235 ms | 294 ms | 5,168 | $0.217 |
| 30 | 261 ms | 911 ms | 6,746 | $0.283 |

Hence the 1,200 ms default deadline: headroom for the tail without a stalled request
sitting in front of a rendered page. Search-as-you-type would need a tighter budget, fewer
candidates, and a closer endpoint.

**What it buys, in one example.** Asked *"car break in"*, lexical retrieval returns
`PERSON BREAKING IN` calls — the words match. Jev scores them **1.3 of 4, "same general
area of activity, but not what they asked about"**, because a person breaking into a
building is not a car break-in. Asked *"someone with a knife"*, `PERSON W/KNIFE` scores
3.95. That distinction is the entire value: the retriever decides what is in the running,
the model decides the order within it, and the reader sees the ladder label next to each
result rather than an unexplained ranking.

The route in is the grammar's own tail: words Tier 1 could not place are a *search*, not a
failure. "anything about a boarded up storefront on valencia" has no category in our
taxonomy, and search finds the FIGHT W/WEAPONS call at Mission & Valencia anyway.

### Retrieval is two steps, because ranking cannot fix recall

The first version ranked well and retrieved badly. Measured on live data: **"gunshots"
returned zero candidates** while `SHOTS FIRED` and `PERSON W/GUN` records sat in the
database, because a stemmer does not connect the word a person uses to the words an agency
writes — and a re-ranker cannot reorder an empty list.

So a question is expanded into *types and agency codes* before anything is retrieved:

1. **Our own vocabulary, deterministic.** The ask grammar's category phrases, a short list
   of colloquial forms ("gunshots", "smashed", "not breathing"), and — the part that scales
   — the agency's own labels in `event_taxonomy`, so "knife" reaches `PERSON W/KNIFE`
   without anyone writing that mapping down.
2. **Jev's judgement, optional.** One small request with no candidates in it: a boolean per
   product type, "is the query asking about *fire* calls?". Multi-label rather than a single
   choice, because "break-in" really is both burglary and theft. ~$0.08 per 1,000 plans.

Two selection rules, both from measurement rather than taste:

- **Relative, not absolute.** On "gunshots" the answers were weapon 0.98, public_safety
  0.83, disturbance 0.66, medical 0.61. A flat 0.6 gate retrieves four categories for a
  question about one, so a type is kept only if it is within 0.15 of the strongest, capped
  at three.
- **Catch-alls never widen a query, and never stand in for one.** `public_safety`,
  `police_activity` and `unknown` score high on almost anything. Retrieved beside `medical`,
  `public_safety` buried "person not breathing" under suspicious-person calls.

  The original rule kept them "when nothing more specific was judged at all", and that half
  was **wrong** — corrected against live data on 2026-09-21. Asked about *prostitution*, a
  subject this taxonomy has no category for, Jev judged only `public_safety` and the answer
  became **2,069 public-safety calls in 90 days**, none of them what was asked, while the
  two records that were — `PROSTITUTE/SOLICITE` and `Solicits For Act Of Prostitution` —
  were never returned. A catch-all as the *only* judgement means the taxonomy has no answer,
  which is a fact to state rather than a gap to paper over. The plan now comes back empty
  and the question goes to keyword search, which finds both records by their words and
  labels the first "exactly what they asked about".

  The answer leads with those two records. Leading with "14,656 calls of every kind" and
  burying them below it is a worse answer than saying plainly that nothing in the taxonomy
  covers the question — and that holds when the search finds *nothing*, too: "nothing
  matched, and here is why" is an answer, "1,318 reported calls in the Tenderloin" is not.

### Some subjects are searchable rather than typed

`Prostitution` (1,125 reports across seven codes) and the trafficking categories are
deliberately **not** mapped onto a product type. Every type broad enough to hold them —
`disturbance`, `public_safety` — puts them in a breakdown beside vandalism and lost
property, which is a worse answer than no type at all. They stay reachable through the
agency's own vocabulary: `647B` on the dispatch side, the `13xxx` family in incident
reports, wired into the query expansion with no type attached.

**One prefix match had to be switched off.** `sex*` reaches `SEXUAL ASSAULT ADULT`, and the
top four hits for "sex work in the mission" were all sexual assault calls — answering a
question about sex work with a list of assaults is the worst failure this search can
produce. `sex` is now matched exactly. Prefix matching is kept everywhere else, because it
is what makes "gun" reach `PERSON W/GUN`.

Result, live: "gunshots" → weapon calls. "someone smashed a car window" → theft and
disturbance, top hit `AUTO BOOST / STRIP`. "person not breathing" → medical. None of those
three questions shares a word with the records it now finds.

### Where the remaining limit actually is

Asked to separate a car break-in from a smashed shop window, Jev scores every candidate
"partially matches" — `AUTO BOOST / STRIP` at 2.45, `VANDALISM` at 2.32, overlapping. That
is not a failure of the model; it is the honest reading of a record that is a code, a
label, a corner and a unit list, with **no narrative at all**. Nothing in the data says a
window was broken. A model that answered "exactly what they asked about" here would be
inventing.

The distinction that *does* exist lives in the agency's code — `852` is a vehicle burglary,
`594` is vandalism — so the expansion carries codes **in priority order** and the answer is
ordered by that rank before recency. Deterministic, free, and sharper than a semantic score
on evidence this thin. The model then orders *within* that, and only when it separated the
candidates by at least half a level; when everything lands in one band the code order
stands and the page says so ("the records were too alike to rank further").

The rule this leaves behind: **use the model where meaning is in the language, and a
lookup where meaning is in the data.** Asking a model to recover a fact the record never
carried produces confident noise.

## What the ranking claims

"Most interesting" is a ranking we have to be able to defend, so every point it awards is
something a reader can check: what the agency called it, how urgently it was dispatched,
how many units went, and whether a second agency responded nearby. The answer says so in
those words, and says what it is not: **a ranking of dispatch activity, not of harm.**

## What the ask box refuses

Questions about safety, injury, arrest, identity or causation are detected and answered
honestly — the system reports what was dispatched, not what happened to anyone, and points
to 911 for emergencies. An empty result says that nothing was *dispatched and published*,
not that nothing happened, and names the two reasons the data would be quiet anyway: the
~30 minute publication delay, and sensitive calls published without a location (docs/01 §8).

## Coverage

`apps/web/test/fixtures/ask-questions.json` holds 69 real-shaped questions asserted against
their expected parse; CI fails on a regression. The spec asks for ≥100, and the two
currently-unresolved cases are named in the test: landmark questions ("union square", "the
embarcadero"), which the grammar resolves to neighborhoods rather than points.
