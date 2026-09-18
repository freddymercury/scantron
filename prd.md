# San Francisco Real-Time Incident Intelligence

## Product Requirements Document

**Status:** Draft
**Market:** San Francisco, California
**Initial platform:** Web
**Initial agencies:** SFPD, SFFD, EMS
**Primary data sources:** San Francisco CAD/public dispatch data, public-safety radio audio where legally and technically available

---

# 1. Product Summary

Build a real-time system that converts fragmented public-safety data into a structured, continuously updated feed of incidents occurring across San Francisco.

The product combines:

* public CAD / dispatched-call data
* public radio transmissions
* speech-to-text
* location and entity extraction
* incident correlation
* timeline construction
* machine-generated summaries
* alerts
* map and feed interfaces

The core product is **not a police scanner**.

The core product is a canonical incident stream:

**raw public signals → normalized observations → correlated incidents → understandable real-time intelligence**

A user should be able to open the application and quickly answer:

* What is happening?
* Where is it happening?
* When did it start?
* Which agencies are responding?
* How serious does it appear?
* Is the incident still active?
* What has changed since the initial report?
* What information is reported versus independently corroborated?

---

# 2. Product Vision

Create a real-time structured representation of significant events happening in a city.

San Francisco serves as the first market because multiple useful public data sources exist, geography is constrained, and the city's dispatch systems create a useful environment for testing event correlation.

The longer-term product may expand beyond public safety into:

* traffic incidents
* transit disruptions
* fires
* severe weather
* 311 activity
* infrastructure failures
* emergency alerts
* public event disruptions
* local news
* user-contributed observations

The long-term abstraction is therefore:

**City Event Intelligence Platform**

rather than:

**Scanner Application**

---

# 3. Problem

Public-safety information currently exists across fragmented sources.

A single incident may appear independently as:

* a CAD entry
* a police dispatch transmission
* a fire dispatch
* an EMS dispatch
* several subsequent radio transmissions
* a traffic incident
* an emergency alert
* a news report

Each signal may describe the same underlying event differently.

For example:

```text
21:43:12
CAD:
ASSAULT / BATTERY
19TH AVE / IRVING ST

21:43:18
Police radio:
"Respond Irving and Nineteenth..."

21:44:03
Fire CAD:
Medical Incident
19TH AVE / IRVING ST

21:45:11
Radio:
"Medic requested..."
```

Existing scanner products generally expose these as disconnected audio or individual dispatch records.

The desired system instead creates:

```text
ASSAULT / MEDICAL RESPONSE

19th Ave & Irving St
Sunset District

Reported: 9:43 PM
Status: Active

SFPD responding
EMS responding

9:43 PM — Incident reported
9:43 PM — Police dispatched
9:44 PM — EMS requested
9:45 PM — Medic dispatched
```

One real-world event becomes one evolving digital object.

---

# 4. Goals

## 4.1 MVP Goals

The San Francisco MVP must:

1. ingest real-time San Francisco dispatch data
2. normalize records into a common event schema
3. detect when multiple records represent the same incident
4. continuously update an existing incident rather than create duplicates
5. show incidents on a map
6. show incidents in a chronological feed
7. construct an incident timeline
8. represent incident status
9. distinguish reported information from higher-confidence information
10. support real-time client updates
11. support historical incident lookup
12. create a foundation for radio transcription

---

# 5. Non-Goals for Initial MVP

The first release will not attempt to:

* monitor encrypted communications
* decrypt encrypted communications
* provide tactical police tracking
* expose sensitive tactical locations
* create officer-level tracking
* create victim or caller profiles
* identify private individuals from scanner traffic
* predict crime
* predict police activity
* provide navigation designed to avoid law enforcement
* replace official emergency information
* act as an emergency-response service
* provide guaranteed comprehensive city coverage
* automatically treat scanner statements as verified facts

Native mobile applications are also out of scope for the first version.

The initial product should be responsive web-first.

---

# 6. Target Users

## 6.1 General Public

Users who want situational awareness around events occurring near them or elsewhere in San Francisco.

Example needs:

* Why are there multiple fire trucks nearby?
* What happened near a particular intersection?
* Why is traffic blocked?
* Was there a major incident in my neighborhood?

## 6.2 Journalists

Reporters monitoring developing events.

Potential capabilities:

* significant-event alerts
* neighborhood monitoring
* event timelines
* source attribution
* historical search

## 6.3 Local Newsrooms

Operational monitoring of multiple incidents simultaneously.

Potential future capabilities:

* Slack integration
* newsroom alert rules
* saved geographical regions
* keyword alerts
* incident escalation
* API access

## 6.4 Researchers and Civic Organizations

Historical analysis of public incident activity.

## 6.5 Developers

Future users of a structured incident API.

---

# 7. Core Product Concept: Incident

The canonical unit of the system is an **Incident**.

An Incident represents the system's best current understanding of one real-world event.

Multiple observations can belong to one Incident.

Example:

```text
Incident
  ├── SFPD CAD observation
  ├── police dispatch transmission
  ├── SFFD CAD observation
  ├── EMS dispatch transmission
  └── subsequent radio update
```

This distinction between **Observation** and **Incident** is foundational.

---

# 8. Observation Model

An Observation is a single incoming source record.

Examples:

* CAD record
* radio transmission
* CHP record
* emergency notification
* transit alert

Proposed model:

```ts
interface Observation {
  id: string;

  source:
    | "sf_police_cad"
    | "sf_fire_cad"
    | "sf_ems_cad"
    | "radio"
    | "other";

  sourceRecordId?: string;

  agency?: string;

  occurredAt: Date;
  ingestedAt: Date;

  type?: string;
  subtype?: string;

  priority?: string;

  location?: {
    raw?: string;
    normalized?: string;

    address?: string;
    intersection?: string;

    latitude?: number;
    longitude?: number;

    neighborhood?: string;
  };

  units?: string[];

  text?: string;

  audio?: {
    url?: string;
    duration?: number;
    talkgroup?: string;
    frequency?: number;
  };

  metadata?: Record<string, unknown>;

  confidence: number;
}
```

---

# 9. Incident Model

```ts
interface Incident {
  id: string;

  primaryType: IncidentType;

  title: string;

  agencyTypes: Array<
    "police" |
    "fire" |
    "ems" |
    "other"
  >;

  priority?: string;

  severity?: IncidentSeverity;

  status:
    | "reported"
    | "dispatched"
    | "active"
    | "contained"
    | "resolved"
    | "unknown";

  location: {
    displayName?: string;

    address?: string;
    intersection?: string;

    latitude?: number;
    longitude?: number;

    neighborhood?: string;
  };

  firstObservedAt: Date;
  lastUpdatedAt: Date;
  resolvedAt?: Date;

  units: string[];

  observationIds: string[];

  timeline: TimelineEvent[];

  summary?: string;

  confidence: number;

  verification: {
    sourceCount: number;
    independentSourceCount: number;

    classification:
      | "reported"
      | "multi-source"
      | "official-response-confirmed";
  };
}
```

---

# 10. Incident Types

Initial normalized incident categories should remain deliberately broad.

Suggested top-level taxonomy:

```text
Fire
Medical
Collision
Assault
Weapon
Robbery
Burglary
Theft
Disturbance
Missing Person
Hazard
Rescue
Traffic
Public Safety
Police Activity
Unknown
```

Raw agency codes must remain stored separately.

Example:

```text
raw_type:
"22500E"

normalized_type:
"Traffic"
```

The normalization layer should be configurable rather than hardcoded throughout the application.

---

# 11. Data Sources

## Phase 1

### San Francisco Police Dispatch / Calls for Service

Use San Francisco's publicly available real-time dispatched-call data.

The ingestion service should periodically request new or modified records.

Recommended initial polling frequency:

```text
10–30 seconds
```

The ingestion process must be idempotent.

Repeated retrieval of the same record must not create duplicate observations.

### San Francisco Fire / EMS

Ingest fire and emergency medical dispatch information.

Convert agency-specific schemas into the common Observation model.

---

# 12. Radio Integration

Radio is Phase 2.

Radio sources may include:

* appropriately licensed third-party feeds
* OpenMHz where permitted
* Broadcastify where licensed
* self-operated SDR infrastructure
* other legally accessible public radio sources

Encrypted communications are out of scope.

The system must never attempt to defeat radio encryption.

---

# 13. Radio Capture Model

The preferred architecture captures individual transmissions rather than one continuous audio stream.

Example:

```text
Transmission

time: 21:43:18
talkgroup: SFPD Dispatch
duration: 4.2 sec
audio: transmission.wav
```

Individual transmissions dramatically improve:

* cost
* transcription accuracy
* correlation
* replay
* timeline generation
* metadata retention

---

# 14. Speech-to-Text Pipeline

Pipeline:

```text
radio transmission
        ↓
audio preprocessing
        ↓
speech detection
        ↓
speech-to-text
        ↓
domain normalization
        ↓
entity extraction
        ↓
observation
```

Candidate speech providers:

* OpenAI transcription
* Deepgram
* local Whisper models

The architecture must support multiple providers behind a common interface.

Example:

```ts
interface TranscriptionProvider {
  transcribe(
    audio: Buffer,
    context?: TranscriptionContext
  ): Promise<Transcript>;
}
```

---

# 15. Domain Vocabulary

Transcription must support contextual vocabulary.

San Francisco street names are especially important.

Example contextual dictionary:

```text
Geary
Taraval
Judah
Irving
Noriega
Clement
Balboa
Sloat
O'Shaughnessy
Cesar Chavez
Embarcadero
Presidio
Brotherhood Way
Great Highway
```

The vocabulary system should also support:

* unit identifiers
* district names
* police codes
* fire terminology
* EMS terminology

---

# 16. Location Normalization

Location normalization is a major system component.

Incoming locations may appear as:

```text
19TH AV/IRVING ST
```

```text
19th and Irving
```

```text
IRVING / 19TH
```

```text
19TH AVE AT IRVING
```

These should normalize into:

```json
{
  "intersection": "19th Ave & Irving St",
  "neighborhood": "Inner Sunset"
}
```

The system should maintain:

* raw location
* normalized location
* geocoded coordinates
* neighborhood
* confidence

---

# 17. Incident Correlation

Incident correlation is the most important intelligence component.

The system must estimate whether a new Observation belongs to:

1. an existing Incident
2. a new Incident

Correlation signals include:

* geographic proximity
* temporal proximity
* event type
* dispatch code
* agency
* unit identifiers
* addresses
* intersections
* transcript entities
* talkgroup
* related incident identifiers

Example scoring model:

```text
location similarity       35%
time similarity           25%
event similarity          20%
unit overlap              10%
text/entity similarity    10%
```

The exact weights should be configurable.

---

# 18. Correlation Thresholds

Example behavior:

```text
score >= 0.85
Automatically merge

0.65–0.84
Probable match

< 0.65
Create new incident
```

During early development, probable matches should be logged for evaluation.

A future internal review UI may allow manual merge/split corrections.

---

# 19. Incident Lifecycle

Typical lifecycle:

```text
reported
   ↓
dispatched
   ↓
active
   ↓
resolved
```

Not every incident will provide enough information to complete this lifecycle.

Therefore:

```text
unknown
```

must remain valid.

The system must not invent a resolution state.

---

# 20. Timeline

Every Incident contains a chronological timeline.

Example:

```text
9:43:12 PM
Initial police dispatch record received

9:43:19 PM
Police unit dispatched

9:44:02 PM
Medical assistance requested

9:44:21 PM
Medic 18 dispatched

9:46:03 PM
Additional police unit assigned
```

Every timeline event must retain its underlying source reference.

---

# 21. Summarization

Summaries should be created only after structured extraction.

Preferred order:

```text
source
 ↓
observation
 ↓
normalization
 ↓
correlation
 ↓
incident state
 ↓
summary
```

Not:

```text
raw audio
 ↓
LLM guesses everything
```

The LLM summarizes the structured state.

It should not be the primary source of truth.

Example:

```text
Police and medical units are responding to a reported assault near 19th Avenue and Irving Street. The incident was first reported at approximately 9:43 PM.
```

---

# 22. Confidence

Every Incident should expose confidence internally.

Potential dimensions:

```text
locationConfidence
typeConfidence
correlationConfidence
summaryConfidence
statusConfidence
```

The UI does not necessarily need to expose numerical scores.

Instead it may communicate certainty linguistically.

Examples:

```text
Reported assault
```

versus:

```text
Police and EMS responding to reported assault
```

The second statement confirms response activity, not that the underlying allegation occurred exactly as initially reported.

---

# 23. Verification Classification

Each Incident should receive one of the following internal classifications:

### Reported

One source has reported the event.

### Multi-source

Multiple independent observations appear to describe the same event.

### Official-response-confirmed

Official response activity is independently visible across sources.

This classification does not mean the underlying allegation itself has been proven.

---

# 24. Web Application

The MVP web application requires two principal interfaces.

## Map

Display active and recent incidents geographically.

Each marker should encode:

* incident category
* approximate location
* age
* status

Selecting a marker opens the Incident detail panel.

## Feed

Reverse chronological incident stream.

Example:

```text
9:48 PM
🔥 Structure Fire
Mission District
Active

9:45 PM
🚑 Medical Emergency
Outer Sunset
Active

9:43 PM
🚓 Assault / Medical Response
Inner Sunset
Active
```

---

# 25. Incident Detail Page

Incident page requirements:

```text
Incident title

location
neighborhood

first reported
last updated
status

responding agencies

timeline

summary

source indicators

map

last update timestamp
```

Radio transcript snippets may appear after radio integration.

Raw sensitive audio should not automatically be exposed publicly.

---

# 26. Real-Time Updates

Clients should receive updates without requiring refresh.

Preferred transport:

```text
Server-Sent Events
```

or:

```text
WebSocket
```

SSE is preferred initially unless bidirectional communication is required.

Typical events:

```ts
incident.created
incident.updated
incident.resolved
incident.merged
```

---

# 27. Search

MVP search should support:

* address
* intersection
* neighborhood
* event type
* incident ID

Future search may include natural-language queries.

Example:

```text
fires in the Sunset yesterday
```

---

# 28. Filters

Initial filters:

* Police
* Fire
* EMS
* Active
* Recently resolved
* Neighborhood
* Event category
* Time range

---

# 29. Alerts

Alerts are a post-MVP feature but architecture should support them.

Potential alert rules:

```text
new structure fire within 2 miles

major police response in Sunset

incident involving 5+ responding units

new incident near saved location

specific event category
```

Delivery channels may eventually include:

* push notifications
* SMS
* email
* Slack
* Discord
* webhook

---

# 30. Safety and Privacy Requirements

The product must intentionally avoid becoming a tactical law-enforcement monitoring tool.

Public-facing information should generally omit or delay:

* tactical officer positions
* undercover activity
* SWAT movements
* active pursuit tactics
* victim identities
* caller identities
* medical information
* license plates
* personally identifying information
* detailed suspect hiding locations when disclosure could create immediate harm

The system should support:

```ts
visibility:
  | "public"
  | "delayed"
  | "restricted"
  | "discard"
```

for incoming observations.

---

# 31. Public Delay

The architecture must support configurable publication delay.

Example:

```text
ingest immediately

process immediately

public display:
+5 minutes
```

Delay may vary by source and incident classification.

This should be configuration-driven.

---

# 32. Source Traceability

Every displayed fact should be traceable internally to one or more observations.

Example:

```text
Medic 18 dispatched
```

should internally point to:

```text
sf_fire_cad observation 8fd...
```

This enables:

* auditing
* corrections
* confidence calculation
* future editorial review

---

# 33. Corrections

Incoming data can be wrong.

The product must preserve historical state while allowing corrections.

Example:

```text
initial:
SHOTS FIRED

later:
FIREWORKS / UNFOUNDED
```

The system should update the current Incident state while preserving the timeline.

It should not silently erase the initial dispatch.

---

# 34. Architecture

Recommended initial stack:

```text
Bun >= 1.4
TypeScript

Next.js
React
Material UI

Supabase / PostgreSQL

SSE

OpenAI / Deepgram abstraction

MapLibre or Mapbox
```

---

# 35. Repository Structure

```text
/apps

  /web


/services

  /sf-cad-ingest

  /radio-ingest

  /transcription

  /incident-correlator

  /incident-summarizer


/packages

  /incident-schema

  /location-normalizer

  /sf-domain

  /event-taxonomy

  /transcription-provider

  /database

  /observability
```

A monorepo is recommended.

---

# 36. Database

Primary storage:

**PostgreSQL**

Recommended extensions:

```text
PostGIS
```

PostGIS should support:

* radius queries
* incident clustering
* neighborhood mapping
* proximity matching

---

# 37. Core Tables

Initial database entities:

```text
observations

incidents

incident_observations

timeline_events

locations

units

incident_units

source_records

transcripts

event_taxonomy

source_configuration
```

---

# 38. Idempotency

All ingestion must be idempotent.

Each source should provide or generate:

```text
source
source_record_id
```

and enforce a unique constraint where possible.

Re-reading source data must update existing observations rather than create duplicates.

---

# 39. Processing Queue

MVP does not require Kafka.

Use a simple queue abstraction.

Possible implementations:

* PostgreSQL queue
* Supabase-backed job table
* lightweight Redis queue if needed

Jobs include:

```text
normalize_observation
geocode_location
correlate_incident
transcribe_audio
summarize_incident
publish_incident
```

---

# 40. Observability

Every processing step must be traceable.

Minimum logging fields:

```text
request_id
observation_id
incident_id
source
processor
processing_time
result
error
```

Metrics should include:

* source ingestion lag
* processing latency
* correlation latency
* transcription latency
* failed observations
* duplicate records
* incident merge rate
* uncertain correlations

---

# 41. Product Latency Targets

For CAD:

```text
source record available
→ public incident update

target:
< 30 seconds
```

For radio:

```text
transmission completion
→ transcript

target:
< 10 seconds
```

Full incident enrichment target:

```text
< 20 seconds
```

These are product targets rather than hard guarantees.

---

# 42. Data Retention

Initial recommendation:

Structured incident data:

```text
indefinite
```

Raw observations:

```text
indefinite unless policy requires otherwise
```

Radio audio:

```text
short retention
```

Example:

```text
24 hours–7 days
```

Transcripts:

```text
retain where allowed
```

Audio retention should be reconsidered before production launch.

---

# 43. Administrative Interface

An internal admin interface should eventually provide:

* incident search
* observation inspection
* incident merge
* incident split
* incorrect-location correction
* incorrect-category correction
* transcript correction
* source health
* source latency
* correlation debugging

This is not required for the first demo but will become important quickly.

---

# 44. MVP Phase 0 — Data Feasibility

Goal:

Prove that San Francisco CAD sources can reliably drive an incident feed.

Build:

```text
SF police ingest

SF fire/EMS ingest

normalization

Postgres persistence

basic geographic resolution

raw event viewer
```

Success criterion:

Reliable continuous ingestion for at least several days without duplicate explosions or meaningful data loss.

---

# 45. MVP Phase 1 — Incident Intelligence

Build:

```text
Incident model

correlation engine

incident lifecycle

timeline

map

feed

incident detail page

SSE updates
```

Success criterion:

A user looking at the feed sees recognizable real-world events rather than raw agency records.

---

# 46. MVP Phase 2 — Radio Intelligence

Add:

```text
radio source

individual transmission capture

speech-to-text

domain vocabulary

entity extraction

CAD/radio correlation
```

Success criterion:

Radio contributes meaningful additional information to existing incidents.

It should not simply create a second transcript feed.

---

# 47. MVP Phase 3 — Intelligence Layer

Add:

```text
incident summaries

severity estimates

multi-source verification

significant-event detection

automatic incident prioritization
```

---

# 48. MVP Phase 4 — Notifications

Add:

```text
saved areas

saved categories

alert rules

push/email/Slack/webhook delivery
```

---

# 49. Future Data Sources

Potential expansion:

```text
CHP

511 traffic

SFMTA

BART

311

emergency alerts

earthquakes

weather

power outages

news sources

community reports
```

All should enter through the Observation abstraction.

---

# 50. Geographic Expansion

A city adapter should isolate city-specific integrations.

Example:

```ts
interface CityAdapter {
  ingest(): Promise<Observation[]>;

  normalizeLocation(
    raw: unknown
  ): Promise<NormalizedLocation>;

  classify(
    observation: Observation
  ): Promise<IncidentType>;
}
```

Future structure:

```text
/cities
  /san-francisco
  /oakland
  /san-jose
  /los-angeles
  /new-york
```

The core Incident platform should remain city-independent.

---

# 51. API

The underlying system should eventually expose:

```text
GET /incidents

GET /incidents/:id

GET /incidents/nearby

GET /incidents/active

GET /incidents/history

GET /stream
```

Example:

```text
GET /incidents/nearby
?lat=37.763
&lng=-122.477
&radius=2000
```

---

# 52. Event Stream

Future API consumers should be able to subscribe to:

```text
incident.created

incident.updated

incident.resolved
```

Example event:

```json
{
  "event": "incident.updated",
  "incident_id": "sf_01K...",
  "timestamp": "2026-09-17T21:45:03-07:00"
}
```

---

# 53. Potential Business Model

The consumer feed may remain free.

Possible paid products:

### Consumer Pro

* custom alerts
* larger alert radius
* historical search
* saved locations
* advanced filters

### Newsroom

* Slack alerts
* newsroom dashboard
* collaborative monitoring
* advanced search
* export
* priority support

### API

* structured incident stream
* webhooks
* historical queries
* bulk analytics

### Enterprise / Civic

* custom datasets
* dashboards
* analytics
* geographic intelligence

---

# 54. Important Product Principle

Do not optimize around transcription volume.

Optimize around **signal reduction**.

A city may generate thousands of individual observations.

Users should see dozens of meaningful incidents.

Therefore the key ratio is:

```text
raw observations
        ↓
meaningful incidents
```

The system becomes more valuable as it removes duplication and noise.

---

# 55. Key Technical Risk

The biggest technical risk is not speech recognition.

It is:

**incident identity**

Determining whether:

```text
Police CAD event A

Fire CAD event B

Radio transmission C

Radio transmission D
```

represent:

```text
one event
```

or:

```text
four separate events
```

The quality of that decision will determine the quality of the product.

---

# 56. Key Product Risk

The largest product risk is presenting early dispatch information as established fact.

The UI and data model must continuously distinguish between:

```text
reported
```

and:

```text
confirmed response activity
```

and:

```text
confirmed outcome
```

These are not equivalent.

---

# 57. Key Strategic Advantage

The defensible asset is not scanner access.

Scanner access is replaceable.

Speech-to-text is commoditized.

Maps are commoditized.

The durable asset becomes the system's ability to transform noisy, overlapping public signals into a reliable model of real-world incidents.

Over time the platform develops:

* location normalization
* agency-code mappings
* event taxonomy
* correlation models
* incident histories
* radio vocabulary
* source reliability models
* cross-source relationships
* city-specific domain knowledge

That becomes the underlying intelligence layer.

---

# 58. MVP Success Metrics

Initial engineering metrics:

```text
ingestion uptime > 99%

CAD processing latency < 30 sec

duplicate incident rate < 10%

observation processing failure < 1%
```

Initial intelligence metrics:

```text
correct event category

correct location

correct incident grouping

correct agency association

correct timeline ordering
```

Initial product metrics:

```text
daily active users

incidents opened per session

map interactions

alert subscriptions

return frequency
```

The most important early qualitative metric is:

> Does the system make it easier to understand what is happening in San Francisco than looking at the underlying feeds individually?

---

# 59. Recommended First Build

The first implementation milestone should intentionally exclude radio.

Build:

```text
SF CAD ingestion
+
canonical Observation schema
+
Incident schema
+
PostGIS normalization
+
correlation
+
real-time map
+
incident feed
```

Then run it continuously and observe where the structured data is insufficient.

Radio should then be introduced specifically to fill those gaps.

This avoids prematurely making the system dependent on scanner audio and lets the team validate the central product hypothesis first:

> Multiple fragmented city signals can be transformed into one useful real-time incident model.

---

# 60. Product Definition

The simplest description of the product is:

> **A real-time structured feed of what is happening in San Francisco.**

The first sensors happen to be emergency dispatch systems and public-safety radio.

The underlying architecture should assume that many additional sensors will follow.

