# Greyhaven Life v1.10.0 — Privacy-scoped group bridge

Install with Greyhaven Phone v2.13.0.

- Life's injected World Events and one-time Plans are now filtered to the exact **active group character**. Unrelated group members' phone/world events no longer appear simply because they are members of the group.
- When the active speaker is unknown, private/event/plan injection fails closed (injection omitted rather than exposing everybody's history).
- The GH_ACTION protocol now recognizes validated character Instagram posts, stories, likes, comments, Facebook posts, likes, comments, Snapchat stories and removal of friends. The Phone extension implements those actions; Life alone merely records them.
- Source-character validation rejects hidden actions impersonating a different roleplay speaker.
- Existing slow/frozen clocks, calendars, schedules, garages and properties are preserved. No roleplay metadata migration is required.

**Installation:** back up your current chat and both extensions, upload this archive's `Greyhaven-Life-main/` contents to the existing Life extension, update Phone in the same release, reload, then test in a copied group chat. This was tested offline, not on the live VPS/iPhone.
