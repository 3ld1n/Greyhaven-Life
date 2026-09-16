# Greyhaven Life v1.7.1 — Clock Open Fix

Replace the v1.7.0 Slim files with these files.

Fixes:
- Floating Greyhaven Life clock now opens Greyhaven Phone first, then Life -> Clock.
- Wand / Extensions -> Greyhaven Life uses the same working Clock route.
- If Phone cannot open, a fallback clock panel appears instead of doing nothing.
- GreyhavenLife.open() now points to the slim Clock UI.
- Schedules, exceptions, compact prompt, one-time plans and Phone/world bridge remain intact.

Keep the existing core files in your Greyhaven-Life repository:
- index.js
- bridge.js
- style.css

Replace/add:
- manifest.json
- slim.js

This is a small bug-fix update over v1.7.0.
