# Greyhaven Life v1.0.0

A standalone SillyTavern extension for persistent, chat-scoped life simulation:
roleplay time, current scenes, character locations, availability, recurring
schedules, and compact AI continuity context.

It is designed to become the shared foundation for future extensions such as
Greyhaven Phone, Immersion FX, Story Director, and Parallel Scenes.

## Core design

### Per-chat world state
Greyhaven Life stores its world state inside the current chat's
`chat_metadata.greyhavenLife` object.

That means:
- different chats do not share one universal timeline
- alternate storylines can have different locations/times
- normal SillyTavern branches/checkpoints can inherit the chat metadata and then
  evolve independently

Global display/context preferences are stored in SillyTavern extension settings.

## Roleplay clock

Three modes:

### Real time
Uses the browser/phone's current local date and time.

The HUD can visibly tick without making any model/API request. Before a normal
generation, Greyhaven Life refreshes its prompt context from the current clock.

### Offset
Runs with real time but shifted by a chosen number of minutes.

Useful for:
- Greece or another timezone
- a roleplay that should be one or several hours ahead/behind real life

### Manual
Choose any fictional date/time.

Manual time can:
- continue running after you set it
- remain frozen

Quick actions include:
- +15 minutes
- +30 minutes
- +1 hour
- +3/+4/+6 hours
- next morning
- next day
- use the latest chat message's real timestamp
- sync back to real time

## Current scene

Each chat can track:
- scene name
- location
- short scene note

There is also a button to apply the current scene location as a temporary
location override to the active persona and current character/group members.

## People / "Where is everyone?"

The extension automatically adds:
- the active persona
- the current solo character
- all members of the current SillyTavern group

You can additionally add:
- any character from your SillyTavern character library
- a custom temporary person

Each tracked person supports:

### Default state
- location
- status
- availability
- optional note

### Temporary override
- location
- status
- availability
- optional expiry date/time

Overrides win over schedules.

### Availability
- Available
- Limited
- Busy
- Unavailable
- Sleeping
- Unknown

## Recurring schedules

Every tracked person can have as many recurring schedule blocks as needed.

Each block supports:
- label
- days of week
- start time
- end time
- location
- status
- availability
- priority
- note

Weekday / weekend / every-day presets are included.

Overnight schedules are supported. Example:

Friday 22:00 -> Saturday 06:00

remains active correctly after midnight.

If schedules overlap, the one with higher priority wins.

## AI continuity injection

Greyhaven Life does NOT make a second AI request.

It uses SillyTavern's normal extension-prompt system to inject a compact current
state into the next generation.

Default low-token scope:
- current persona
- current chat/group members
- any manually pinned off-screen person

Optional setting:
- inject all tracked people instead

The generated context looks approximately like:

    [Greyhaven Life — current roleplay state...]
    Current RP date/time: Sunday, Aug 9, 2026, 20:00.
    Current scene: Hospital shift — Greyhaven City Hospital.
    Eldin: location: Home; availability: available.
    Aurora: location: Greyhaven City Hospital; status: On shift;
            availability: busy; schedule: Hospital shift.
    ...

Explicit events in the actual chat are instructed to override stored Life state
when they conflict.

## HUD

A small floating clock pill can be enabled or disabled.

It can show:
- roleplay time
- current scene/location

Tap it to open Greyhaven Life.

The extension also adds "Greyhaven Life" to SillyTavern's Extensions menu.

## Import / export

The Settings tab can:
- copy the current chat's Greyhaven Life JSON
- import JSON into the current chat
- reset only the current chat's Life state

## Public API for future extensions

Greyhaven Life exposes:

    window.GreyhavenLife

Important methods:

    GreyhavenLife.open()
    GreyhavenLife.getState()
    GreyhavenLife.getTime()
    GreyhavenLife.getTimeISO()
    GreyhavenLife.getScene()
    GreyhavenLife.getPeople()
    GreyhavenLife.getPerson(nameOrId)
    GreyhavenLife.getResolvedPerson(nameOrId)
    GreyhavenLife.getPromptSummary()
    GreyhavenLife.setScene(...)
    GreyhavenLife.setRealTime()
    GreyhavenLife.setOffsetMinutes(...)
    GreyhavenLife.setManualTime(...)
    GreyhavenLife.shiftMinutes(...)
    GreyhavenLife.subscribe(...)

Browser events:

    greyhaven-life:changed
    greyhaven-life:tick

These are intentionally provided so Greyhaven Phone and Story Director can use
the same clock, locations, schedules, and availability instead of inventing
their own world state.

## Installation

Install from a Git repository through SillyTavern's extension manager, or place
the folder in your SillyTavern third-party extensions directory.

Repository root should contain:

    manifest.json
    index.js
    style.css
    README.md

## Compatibility

Minimum SillyTavern client version: 1.13.3

This version relies on APIs exposed in current SillyTavern context including:
- chatMetadata
- updateChatMetadata
- saveMetadataDebounced
- setExtensionPrompt
- eventSource / eventTypes
- extensionSettings

## Recommended first test

1. Open an existing roleplay chat.
2. Tap the small Greyhaven Life clock HUD.
3. Keep time on Real Time.
4. Set a current scene, e.g.:
   - Scene: Evening at home
   - Location: Aurora's apartment
5. Open Aurora in People:
   - set base location
   - add a temporary override if desired
6. Add a recurring work schedule:
   - Mon–Fri
   - 08:00–16:00
   - Greyhaven City Hospital
   - status: On shift
   - availability: Busy
7. Open AI Context Preview to verify what the model will receive.
8. Send a normal roleplay message and confirm the character naturally respects
   the current time/location without reciting the metadata.
