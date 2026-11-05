# Public Collection directory continuation

goal: search
manager: search

Completed: browser address foundation for combined presentationKind/curator/subject/order selection, opaque native
cursor round trips, first-page selection changes and selection-preserving restarts. Mounted existing cursor parser
and links share the helper. Full selection parser is deliberately not yet mounted: the installed native query
still supports only id/name/relevance and the Collection source lacks the required operands.

Continue from apps/web/src/library/public-collection-discovery.md and services/kernel/src/search/collection-discovery.md;
owner rules are docs/search-conditions.md and docs/collection-presentation.md. Sources inspected: those four documents,
the named page/read/query/request and route modules, collection-discovery.ts, library/collection-discovery-source.ts,
library/collection-discovery-summaries.ts, discovery request/query/native-query/filter/current/API/document modules.
No outside checkout or undeclared risk files were opened. Commerce was sent the required native extension via inbox.

1. Agree exact native recency tuple units/nullability with Commerce; consume its installed source operands and typed
   query/currentness observations. Do not implement native producer changes twice. Preserve batch100 partition-local
   source read/page and ascending (route,id) indexing frontier; census unavailable is not bounded paging failure.
2. Extend explicit adapter copies and the one projection codec with native kind/mixed, canonical nullable curator,
   disclosed curated/last-complete dynamic subject membership, native nullable recency and follow-count popularity.
3. Admit indexed directory query/sorts with deterministic full identity ties, authenticated complete selection/cursor
   binding, and whole-query monotonic currentness including membership/output/follows, not only Collection revision.
   Charge actual skipped candidates, terminal seeks and partition/current/final validation; finite prep if necessary.
4. Mount selection parser, controls and complete query keys/server inputs/request operands; preserve selection in
   pagination/restart and browser return. Localize controls. Add focused native/consumer tests, run changed test files
   once after final edit with brief's landing commands, and typecheck changed workspaces after committing.
5. Verifier owns seeded native and rendered acceptance at 390/1440 light/dark, two curators, overlap/ties/multipage,
   canonical destination return and ordinary membership/privacy publication changes on retained stack.

This is unfinished product work, not a blocker or completed Path 13 acceptance.

Worker validation: `bun run --cwd apps/web typecheck` exited 1 with 466 TypeScript diagnostic lines. The same
command on the clean aff08a643851773ed9d1e8c61965c895afb6db5e snapshot under .temp/collection-directory-base also
exited 1 with the identical 466 diagnostics after normalizing remote run-directory paths (zero added/removed).
Examples: community/realm-bans.ts BanReviewEndpoints call signatures; generated Kernel SQL module declarations.
No changed file has a diagnostic. Full local logs: .temp/collection-directory-{base-,}typecheck.log.
The focused address file passed all three tests; the existing directory test could not import cloudflare:workers
from src/kernel/client.ts before assertions. Broader native/browser/root acceptance is deferred to integration.
