# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-05) |
| --- | --- |
| Done | Research and decision: [Posts, texts and Works](../../contracts/work-and-release.md#posts-texts-and-works). |
| Running | G-1079 attempt 4 (Sol xhigh): review fixes — migrate unplaced chapter Works by footprint, publisher fallback that never blocks a batch. Attempts 1–3 delivered 2dd929fe3 (103 files; Post profile, creation, custody, comments, rights, search/library/discovery readers, 20 hide filters removed, startup backfill plus a narrow Jena migration policy); its 19 heavy discovery/feed/reading regressions passed with the cost assertions unchanged. |
| Next | addresses-discovery reviews two effects.ts classifications (studio.chapter.create and structure.command → irrelevant). Merge G-1079 with `--allow-scope` (Fuseki tag, release manifest, toolchain, app.ts, Jena policy, media summary, search-state, home-v2 seed, g-1063 effects test), then `task gen` and typecheck; restart the shared dev stack on the new Fuseki image and qualify the startup migration there (count legacy chapter Works before and after, read a seeded serial). Then dispatch G-1080 surfaces (old `/w/<chapter>` addresses need a Post place read), G-1081 notes and G-1082 identification. |
| Coupling | addresses-discovery (rezics-next-1c) owns `discovery/**`, `feed/**`, `notification/**`, which hold chapter-Work filters and mappings; scoped-subjects (rezics-next-97) frames may name chapters. Manager worktree `.temp/worktrees/post-layers-manager`. |
