# Greyhaven Life v1.2.0

A mobile-first SillyTavern extension for persistent, chat-scoped life simulation:
authoritative roleplay time, scene presence, locations, availability, reusable
schedules, obligations, exceptions, and optional AI-assisted world-state analysis.

Greyhaven Life is designed to be the shared world-state foundation for future
extensions such as Greyhaven Phone, Immersion FX, Story Director, and Parallel
Scenes.

## v1.2 highlights

### 1. Actual state vs expected schedule

Schedules no longer need to "teleport" a character.

For a person who is physically Present, actual-state evidence is resolved in
this order:

1. active explicit override
2. current scene location
3. stored / last-known state
4. schedule inference when there is no conflicting actual location

For an off-screen person, a schedule may still infer a likely current state when
there is no stronger stored location.

This allows:

- Actual: Aurora is still at Eldin's Apartment
- Expected: Hospital Shift began at 08:00
- Result: Greyhaven Life can tell the AI that Aurora is late instead of moving
  her to the hospital automatically.

### 2. Routine vs Obligation

Every recurring schedule now has a type:

- **Routine** — gym, coffee, bedtime, usual habits. Skipping it is normal.
- **Obligation** — work shift, class, meeting, appointment, pickup, etc.

Obligations support:

- reminder window in minutes
- late grace period in minutes
- upcoming cues
- late cues
- recently missed cues

Priority still means only: "which block wins if schedules overlap." It does not
mean that a character cares more about that schedule.

Old v1.1 schedules migrate safely as **Routine**. Edit important schedules such
as Aurora's Hospital Shift once and change their type to **Obligation**.

### 3. Schedule exceptions

Each tracked person can create chat-specific exceptions:

- Vacation
- Day off
- Called sick
- Leave
- Cancelled
- Custom

Exceptions have optional start/end times and can suppress scheduled obligations.

An exception that covered a work shift remains capable of excusing that shift
when Greyhaven Life later checks whether it was missed.

### 4. Override can excuse obligations

The person editor now includes:

**Excuses scheduled obligations**

Examples:

- Overslept at Eldin's apartment -> leave OFF -> late cue can happen.
- Called sick / approved leave -> turn ON -> no late warning.

### 5. Global default schedules

Character/persona schedules no longer need to be recreated in every chat.

Global defaults live in Greyhaven Life extension settings, outside character
prompt text.

When a person is first tracked in a new chat, their global defaults are copied
into that chat with independent schedule IDs.

Editing the chat copy does not change the global default.

Per-person schedule actions:

- **Defaults** — edit reusable global defaults
- **Update from defaults** — synchronize linked defaults and add missing ones;
  completely chat-local schedules remain
- **Reset to defaults** — replace this chat's schedules with global copies
- **Save chat as default** — explicitly promote this chat's current schedules
  to future-chat defaults

### 6. Character Management integration

When editing an existing SillyTavern character, Greyhaven Life adds a compact:

**Greyhaven Life Defaults**

button to Character Management.

It opens that character's reusable default-schedule editor without modifying the
character description/card prompt.

The active persona's defaults are also accessible from Greyhaven Life Settings.

### 7. Analyze Current Chat

Overview now has an optional:

**Analyze current chat**

action.

It makes one user-triggered model request and examines:

- the current group/character scenario
- authoritative Greyhaven Life date/time
- existing tracked world state
- a bounded excerpt of the newest roleplay messages

Default limits:

- up to 50 recent messages
- up to 24,000 recent-chat characters
- 1,200-token-ish analysis response budget

The analyzer is conservative:

- strong evidence can propose an update
- no evidence means preserve existing state
- uncertain results should not invent values
- it does not edit schedules, defaults, or exceptions

It proposes:

- scene name/location/note
- Present / Off-screen
- location
- current activity/status
- availability

Before anything is applied, Greyhaven Life shows a review dialog. High/medium
confidence changes are preselected; low-confidence items are not.

The parser accepts normal JSON, fenced JSON, surrounding prose, and locally
repairs simple trailing-comma JSON mistakes without spending a second model
request.

### 8. Shared World Snapshot

After accepted analysis, Greyhaven Life stores one structured per-chat World
Snapshot containing:

- analysis time
- analyzed chat length
- scene
- resolved people state
- short summary
- analysis source/budget information
- dirty/fresh status

Snapshot freshness tracks:

- new messages since analysis
- manual Life changes after analysis

This is intentionally designed so future **Greyhaven Phone** / Snap Map can reuse
the same world understanding instead of making another AI request just to learn
where everyone is.

Public API additions:

    GreyhavenLife.getWorldSnapshot()
    GreyhavenLife.getWorldSnapshotStatus()
    GreyhavenLife.analyzeCurrentChat()
    GreyhavenLife.getDefaultProfile(nameOrId)

### 9. Authoritative clock retained

The v1.1 exact-time rule remains unchanged.

The model is explicitly told the Greyhaven Life clock is the exact fictional
time now and must not invent a different current time from old messages,
timestamps, or schedule assumptions.

## AI context philosophy

Greyhaven Life treats schedules as continuity cues, not commands.

The prompt explicitly tells the model:

- newest explicit roleplay events beat stale Life state
- a present person's actual scene state beats a conflicting schedule
- characters may forget, skip, call sick, take leave, be on vacation, or
  deliberately miss obligations
- off-screen world-state facts are not automatically known by every character

Relevant context mode continues to include:

1. Present people
2. active SillyTavern responder characters
3. pinned off-screen people
4. tracked people explicitly named in the newest user message

## World analyzer is optional

Normal Greyhaven Life operation still makes **no extra model request**.

The clock, schedule resolution, presence, obligation checking, exceptions and
prompt injection run locally.

The only new model request occurs when the user explicitly presses
**Analyze current chat**.

## Per-chat state vs global defaults

Per-chat metadata stores:

- clock
- scene
- tracked people
- presence
- current/base state
- overrides
- chat schedules
- exceptions
- World Snapshot

Extension settings store:

- display/context preferences
- analyzer limits
- reusable global default schedules

This keeps alternate chats/checkpoints independent while still allowing a
character such as Aurora to carry a reusable normal hospital schedule into a
brand-new roleplay.

## Suggested first v1.2 test

1. Open Aurora's existing Hospital Shift.
2. Change Schedule Type to **Obligation**.
3. Set reminder 60m and grace 10m.
4. Set manual time to 07:20 while Aurora is Present at Eldin's Apartment.
5. Inspect AI Context Preview: Hospital Shift should appear as upcoming.
6. Set time to 08:20 without moving Aurora.
7. Inspect AI Context Preview: Aurora should be about 20 minutes late and should
   NOT be teleported to the hospital.
8. Add a Vacation or Called Sick exception covering 08:20; the late cue should
   disappear.
9. Use **Save chat as default** for Aurora.
10. Open Character Management -> Aurora -> **Greyhaven Life Defaults** and
    verify the schedule is there.
11. In a new test chat, add Aurora to Greyhaven Life and confirm her global
    schedule is copied automatically.
12. Press **Analyze current chat**, review its proposed scene/person states, and
    apply selected changes.
13. Check Overview: the World Snapshot status should show it was analyzed through
    the latest message.

## Installation

Repository root:

    manifest.json
    index.js
    style.css
    README.md

Minimum SillyTavern client version remains 1.13.3.

## v1.2.1 hotfix

This release fixes the v1.2.0 startup regression.

- Restored the missing self-initialization call at the end of `index.js`.
- Added defensive initialization error handling so a future startup failure is visible in the console/toast instead of silently disappearing.
- Replaced the whole-document MutationObserver with an observer scoped only to SillyTavern's Extensions menu. This prevents Greyhaven Life from reacting to every chat-message or popup DOM mutation and reduces unnecessary UI lag.
- All v1.2 features remain unchanged: global default schedules, obligations, exceptions, actual-vs-expected state, Analyze Current Chat, and shared World Snapshot.

## v1.2.2 hotfix — Chat Scenario Override analysis

- Fixed **Analyze Current Chat** so it reads SillyTavern's actual per-chat **Chat Character Settings Override → Scenario** value from `chatMetadata.scenario`.
- The chat-specific scenario is now checked before character-card or legacy fallbacks.
- Group descriptions are no longer mistaken for roleplay scenarios.
- The analyzer now treats explicit scenario/setup facts as strong evidence until newer roleplay contradicts them.
- Scenario-only characters can be proposed as present even if their names have not yet appeared in the recent transcript.
- All schedules, obligations, exceptions, global defaults, presence logic, and World Snapshot behavior are unchanged.

## v1.3.0 — schedule memory + precise locations

This version is intended as a stable refinement release.

### Precise locations
Greyhaven Life now separates:
- **Place / venue** — apartment, hospital, cafe, hotel room, park
- **City / area** — Greyhaven, Vienna, Greece, etc.

Old v1.2 location strings are preserved automatically as the place field, so existing chats remain compatible.

The structured location is supported in:
- current scene
- person last-known state
- temporary overrides
- recurring schedules
- global default schedules
- Analyze Current Chat
- World Snapshot / public API

Leaving both schedule location fields blank makes a routine **portable**. This is ideal for sleep, morning routines, yoga, etc. A fixed-location routine such as jogging at Greyhaven Park is not assumed while the character is on an incompatible vacation/trip.

### Schedule timing awareness
The prompt now includes the exact time window and end time of the current scheduled block, plus the next two plausible schedule blocks within roughly 18 hours.

Example:
- Hospital Shift 08:00–16:00 — scheduled end exactly 16:00
- Gym 18:00–19:00 — next likely plan

These are continuity cues, not forced actions.

### Past routine / obligation memory
When the newest user message asks about a past time (for example, "Where were you from 10 am to 11 today?"), Greyhaven Life locally detects the requested time and injects the matching routine/obligation as the **default expected memory**.

Rules:
- explicit roleplay history overrides the routine
- stronger Greyhaven Life state overrides the routine
- if another activity is established, the character can naturally say the routine was skipped
- excused obligations are not assumed
- fixed-location routines are not assumed during incompatible vacation/travel
- location-free routines remain portable and can still happen away from home

No extra model request is used for this schedule memory.

### Analyzer precision
Analyze Current Chat now asks the model to separate specific venue from city/area when the evidence supports it.

### Future Phone support
The public Greyhaven Life API now exposes current and upcoming schedule occurrences for future Phone/Snap Map integration.


## v1.4.1 — World/media bridge + active one-time plans

- Guided/visible RP actions such as `I press unblock` can reconcile block/unblock state even if the model omits the hidden action marker.
- Completed RP photo/video sends can materialize in Greyhaven Phone with a fictional media description and optional caption.
- Active One-Time Plans now resolve into each participant's current location, area, activity/status and availability.
- Newer explicit roleplay state still wins over a plan, so plans remain expectations rather than teleportation rules.
- One-Time Plan cards were restyled to match the compact Greyhaven Life UI.
