# Greyhaven Life v1.7.0 — Slim

This is an OVERLAY update for the existing Greyhaven-Life repository.

Keep these existing files:
- index.js
- bridge.js
- style.css

Replace/add:
- manifest.json
- slim.js

The new manifest loads `slim.js`; Slim imports the existing bridge, and the bridge imports the existing core.
This keeps the proven clock/world/action APIs that Greyhaven Phone already depends on.

## What changes

Greyhaven Life becomes a lightweight clock + schedule backend.

Kept:
- fictional RP clock/date
- floating clock HUD
- recurring schedules
- schedule exceptions: day off, vacation, sick, leave, cancellation/custom
- one-time plans / world-action bridge used by Greyhaven Phone
- public GreyhavenLife API used by the other extensions

Removed from the normal workflow / AI prompt:
- manual People tracking
- present/off-screen management
- manual character locations
- Current Scene form
- Analyze Current Chat / world snapshot requirement
- automatic location-based "late for work" logic

## New schedule rule

An active schedule is a NORMAL EXPECTATION, not forced reality.

Example:
- Aurora has Hospital Shift 08:00–16:00.
- If the RP gives no contrary information, the AI may naturally treat her as being at work.
- If the RP says she is somewhere else, the RP wins.
- If an active exception says Day Off / Sick / Vacation, the obligation is suppressed.
- Life no longer decides someone is "late" because a stored location doesn't match the schedule.

## AI context

The large location/presence dump is replaced with a compact block containing:
- exact fictional time/date
- relevant active schedules
- nearby upcoming schedules
- active exceptions
- one short rule saying RP overrides schedules when explicitly contradictory

## Floating clock

The existing floating clock remains.
Tapping it tries to open:
Greyhaven Phone -> Life folder -> Clock

If Greyhaven Phone is unavailable, a small fallback clock panel is shown.

## Install

Upload/replace `manifest.json` and add `slim.js` in your Greyhaven-Life extension folder/repository.
Do NOT delete `index.js`, `bridge.js`, or `style.css`.
