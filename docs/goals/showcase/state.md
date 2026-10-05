# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-05 13:45 CST) |
| --- | --- |
| Done | Decision 54 in its owners. Merged and closed: G-1109 width renditions (c7b1e8d68; migration 760); G-1110 Work showcase art (d114526a2; migration 770; showcase roles on selection slots, logo key `showcase-logo:<lang>:<tone>`, trailer as a slot revision URL, batch read with srcset); OpenAPI regenerated (f3f1fb065). |
| Running | G-1108 attempt 2 (Sol xhigh): my screenshot review fixes (stray tagline under the stage, Why-here shape, one control row under the stage and none on touch, list thumbnails, portrait crop only when the focal area fits), v2 consumption and Work art wiring. Its branch carries G-1111's commit (faae9677d), so both land together; close G-1111 after. |
| Next | Merge G-1108 (`--allow-scope` for G-1111's files), close G-1111, `task gen`, re-approve package digests with `task dev:refresh` (also migrations 760, 770) once the heavy lock frees. Dispatch G-1123 (Opus, Work art editor) and G-1125 (Sonnet, Work header and seeds); G-1124 (Sonnet, Realm editor) after G-1123 and G-1107's `manage/**`. Wave QA `test --affected 932ada68c`. Follow-ups: batch author proofs (`access/author-baseline.ts`, after G-1081); pre-existing anti-silo import failures in ai-workshop, light-novels, visual-novels. |
| Usage | Claude dispatch restricted until the weekly reset (about 12 h): workers on Sol (`codex`), Luna for translations, Grok/Cursor for bounded UI. |
