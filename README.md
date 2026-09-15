# Greyhaven Life v1.7.0 — Slim Engine

Greyhaven Life is now the lightweight continuity engine behind Greyhaven Phone rather than a second world-management dashboard.

## What stays

- authoritative fictional RP clock/date
- floating clock HUD in the chat
- global recurring schedule defaults
- per-chat schedule exceptions (day off, vacation, sick day, leave, cancellation, custom)
- one-time plan/world/Phone bridge from the existing `bridge.js`
- the existing public Greyhaven Life API for backwards compatibility

## What changes

The old Scene / People / location / availability / Analyze Current Chat workflow is no longer used by the active UI or active Life prompt.

The compact prompt now contains only:
- exact fictional current time
- a relevant active recurring schedule, when one exists
- a nearby upcoming schedule, when useful
- active exceptions

An active schedule is a **normal default**, not a command. If the newest RP establishes a different situation, the RP wins. Greyhaven Life no longer infers that somebody is late because their stored location differs from a work location. It never teleports a character to match a schedule.

## Phone integration

The floating Life clock and the Greyhaven Life extension-menu entry now open:

`Greyhaven Phone → Life → Clock`

when Greyhaven Phone v2.8.0 is present. The Clock app contains the time controls, recurring schedules, and schedule exceptions.

If Greyhaven Phone is unavailable, a small fallback clock panel still opens.

## Important: this ZIP is a PATCH

Keep these existing repository files:
- `index.js`
- `bridge.js`
- `style.css`

Replace/add only the files from this patch:
- `manifest.json`
- `slim.js`
- `README.md`

The new manifest loads `slim.js`; `slim.js` imports the existing `bridge.js`, which in turn imports the existing core `index.js`. This intentionally preserves the working world ledger, Phone action bridge, one-time plans, clock storage, schedule storage, and compatibility APIs.

## Repository cleanup

After the update, the Greyhaven-Life repository root should simply contain:

- `README.md`
- `manifest.json`
- `slim.js`
- `bridge.js`
- `index.js`
- `style.css`

Do not delete `bridge.js`, `index.js`, or `style.css`.

## Tests completed

- `slim.js` JavaScript syntax: PASS
- active recurring obligation becomes the normal default activity: PASS
- Day Off exception suppresses recurring obligation: PASS
- old location/presence/world-snapshot context does not appear in the active Slim prompt: PASS
- old automatic “minutes late” cue does not appear in the active Slim prompt: PASS
- schedule profile API used by Greyhaven Phone Clock: PASS
