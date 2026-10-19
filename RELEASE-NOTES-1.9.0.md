# Greyhaven Life 1.9.0 — Adjustable RP clock and private continuity

- Manual clock can now run at normal speed, 5× slower or 10× slower. One
  fictional minute therefore takes respectively 1, 5 or 10 real minutes.
- The existing frozen clock still works: uncheck “Continue running after I
  set it”, and fictional time remains constant until you move it.
- Changing speed preserves the exact current fictional time (no jump).
- Speed is stored per chat and survives reloads. Older chats default to normal
  speed until you select another rate.
- The Life Time tab and the Phone's Life/Clock tab both expose the speed choice.
- The compact roleplay prompt detects a fictional jump of 30 minutes or more
  since the previous AI turn and asks the model to acknowledge changes of time
  without fabricating off-screen decisions or completed events. Backward time
  moves are also called out.
- The shared world prompt excludes private message and call bodies from its
  group-wide event listing. Phone's existing per-relationship continuity is
  unchanged.

Install alongside Greyhaven Phone 2.11.0. Back up your chat JSONL and the
previous extension folders before replacing the existing Life folder contents.
No live VPS or iOS/PWA compatibility test has been performed here.
