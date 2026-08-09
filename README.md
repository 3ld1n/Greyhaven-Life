# Greyhaven Life v1.1.0

A standalone SillyTavern extension for persistent, chat-scoped life simulation:
authoritative roleplay time, scene presence, character locations, availability,
recurring schedules, and compact AI continuity context.

Greyhaven Life is intended to be the shared world-state foundation for future
extensions such as Greyhaven Phone, Immersion FX, Story Director, and Parallel
Scenes.

## v1.1 highlights

### Authoritative roleplay clock

The model is now given an explicit authoritative clock rule immediately before
generation.

Example:

    AUTHORITATIVE RP CLOCK: 11:36 on Sunday, Aug 9, 2026.
    If anyone asks, reads, states, or reasons about the current time, use 11:36.
    Do not infer another current time from schedules, old messages, prior
    narration, chat timestamps, or assumptions.

The newest roleplay message can still explicitly advance/change time.

The visible HUD continues to run entirely in JavaScript and makes no extra AI
request.

### Tracked is no longer the same as Present

Every person now has a scene-presence state.

For SillyTavern characters:
- Auto from SillyTavern chat
- Present in current scene
- Off-screen

For personas/custom people:
- Present in current scene
- Off-screen

`Auto` follows the current solo character or enabled/unmuted group membership.

The selected SillyTavern persona is deliberately NOT treated as proof that the
persona is physically in the scene.

Newly auto-detected personas start off-screen. Existing v1.0 persona entries
migrate as Present so old chats are not unexpectedly changed.

### Persona removal

Any off-screen tracked person can now be removed, including the selected
persona.

Removing a person also places them on a per-chat ignore list, so the automatic
participant scanner does not immediately add them back.

If the currently selected persona was removed, the People tab shows an
`Add active persona` button to explicitly restore them.

Removed SillyTavern characters can be restored through the normal
`Add character` selector.

### Smarter low-token AI context

Relevant mode now includes:
1. people physically Present in the scene
2. current SillyTavern character/responder candidates
3. manually pinned off-screen people
4. tracked people explicitly named in the newest user message

This means a message such as:

    Aurora, do you know where Jack is?

can temporarily pull Jack's current Life state into that generation without
requiring Jack to be permanently pinned.

Off-screen locations remain world-state facts only. The prompt explicitly warns
the model that another character does not automatically know them unless the
roleplay establishes that knowledge.

## Per-chat world state

Greyhaven Life stores its state inside the current chat's metadata.

Different chats/checkpoints can therefore maintain independent:
- time
- scene
- tracked people
- presence
- schedules
- locations
- overrides

## Roleplay clock modes

### Real time
Uses the browser/phone's current local date and time.

### Offset
Follows real time with a chosen minute/hour offset.

### Manual
Choose any fictional date/time and either:
- continue running from that point
- freeze time

Quick actions include:
- +15m
- +30m
- +1h
- +3h / +4h / +6h
- next morning
- next day
- latest message real timestamp
- sync to real time

## Current scene

Each chat can track:
- scene name
- location
- short continuity note

`Apply location to present people` applies the scene location only to people
currently marked Present. Off-screen people are left untouched.

## People / Where is everyone?

Tracked people can keep:
- default location
- status
- availability
- notes
- temporary override
- recurring schedules
- AI pin
- scene presence

Availability:
- Available
- Limited
- Busy
- Unavailable
- Sleeping
- Unknown

Presence is intentionally independent from availability. Someone may be:
- Present + Busy
- Present + Sleeping
- Off-screen + Available
- Off-screen + Working

## Recurring schedules

Each tracked person can have unlimited recurring blocks with:
- label
- days
- start/end time
- location
- status
- availability
- priority
- optional note

Overrides beat schedules.

Overnight blocks such as Friday 22:00 -> Saturday 06:00 are supported.

## AI continuity injection

Greyhaven Life does not make a second model request.

It refreshes a compact extension prompt before the normal SillyTavern
generation.

Example:

    [Greyhaven Life — authoritative current roleplay state.]
    AUTHORITATIVE RP CLOCK: 11:36 on Sunday, Aug 9, 2026.
    Current scene: Morning at home — Eldin's Apartment.
    Eldin: presence: present in the current scene; location: Eldin's Apartment.
    Aurora: presence: off-screen; location: Greyhaven City Hospital;
            status: Working; availability: busy; schedule: Hospital Shift.

## Public API

Greyhaven Life exposes:

    window.GreyhavenLife

Important methods:

    GreyhavenLife.open()
    GreyhavenLife.getState()
    GreyhavenLife.getTime()
    GreyhavenLife.getTimeISO()
    GreyhavenLife.getScene()
    GreyhavenLife.getPeople()
    GreyhavenLife.getPresentPeople()
    GreyhavenLife.getPerson(nameOrId)
    GreyhavenLife.getResolvedPerson(nameOrId)
    GreyhavenLife.isPresent(nameOrId)
    GreyhavenLife.setPresence(nameOrId, "auto" | "present" | "offscreen")
    GreyhavenLife.getMentionedPeople()
    GreyhavenLife.getPromptSummary()
    GreyhavenLife.setScene(...)
    GreyhavenLife.setRealTime()
    GreyhavenLife.setOffsetMinutes(...)
    GreyhavenLife.setManualTime(...)
    GreyhavenLife.shiftMinutes(...)
    GreyhavenLife.subscribe(...)

This presence-aware API is intended for future Phone/Snap Map and Story Director
integration.

## Upgrading from v1.0.1

Existing:
- times
- schedules
- locations
- overrides
- notes
- pins

are preserved.

Presence migration:
- existing character entries -> Auto
- existing persona entries -> Present
- existing custom entries -> Off-screen

After upgrading, open People once and adjust any old persona/character that is
not physically present in the current scene.

## Recommended v1.1 test

1. Upgrade an existing test chat.
2. Open People.
3. Mark the persona Present or Off-screen.
4. Mark a character Off-screen and confirm Remove appears.
5. Remove the persona if desired; confirm it stays removed after Re-scan.
6. Use `Add active persona` to restore it.
7. Keep Aurora on a work schedule and set the clock to 11:36.
8. Ask Aurora the current time and verify she uses the Greyhaven Life clock.
9. Track Jack off-screen but do not pin him.
10. Ask `Where is Jack?` and inspect AI Context Preview; Jack should be included
    only because his name appears in the newest user message.

## Installation

Repository root:

    manifest.json
    index.js
    style.css
    README.md

Minimum SillyTavern client version remains 1.13.3.
