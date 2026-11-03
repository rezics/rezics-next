---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'interface',
  'riskAreas': ['authorization', 'disclosure', 'rights', 'account', 'deletion'],
  'criticalPath': false,
  'after': ['d2e1f19d-a8bb-4b23-af09-b6fe9b928947', '5a2e66c9-3f0d-4168-a2ad-117772a89e39'],
  'waiting': [],
  'paths':
    [
      'apps/web/src/identity/page-loaders.ts',
      'apps/web/src/threads/board-opening*.ts*',
      'apps/web/src/threads/board-opening*.md',
      'apps/web/src/threads/board-reading.ts',
      'apps/web/src/threads/board-feed-data.ts',
      'apps/web/src/threads/board-feed.tsx',
      'apps/web/src/threads/board-page-caller.tsx',
      'apps/web/src/threads/board-page-lifetime.md',
      'apps/web/src/threads/board-pins.md',
      'apps/web/src/threads/README.md',
      'apps/web/src/routes/boards/$id.tsx',
      'apps/web/src/stories/board-native-opening.stories.tsx',
      'apps/web/tests/board-native-opening*.test.ts*',
      'apps/web/messages/*.json',
      'docs/goals/web.md',
      'packages/client/src/index.ts',
      'packages/client/src/kernel/content/routes.d.ts',
      'contracts/openapi.json',
    ],
  'acceptance':
    {
      'command':
        [
          'bun',
          'apps/web/scripts/focused.ts',
          '--private-network',
          '--',
          'bun',
          'test',
          'tests/board-native-opening.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'Consume the installed typed Board page once and render current Board/community context, rules, five initial pins, twenty ordinary candidates, author/media context and admitted interactions without per-row enrichment or false count defaults.',
          'Continue the ordinary source without repeating the initial pin cohort; preserve sparse empty continuation, sort semantics, same-input retry and explicit invalid-cursor restart.',
          'Pass exact native targets and advice to existing reaction, reply, watch, pin and slow-mode owners; readability and successful transport never imply participation or moderation.',
          'Retire context, media grants, interactions, actions, cohort, frontier and late effects on viewer, credentials, locale, route, exposure, source and connection replacement while preserving the actual-reader transfer boundary.',
          'Cover current optional context failure, concealed identities, signed-out/nonparticipant/moderator advice, zero versus omitted reactions, denied actions, thread return, pin ABA, rank unavailable, and retry/restart focus.',
          'At fixed cohorts of 1, 10 and 25 rows, record response-proportional consumer work with one native opening request per explicit read; keep Content physical growth and authority evidence separate.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 2400, 'files': 23 },
}
---

# Finish the native Board opening receiver

Content's source-side `GET /v1/boards/:id/page` is present, but Web cannot consume it until the generated
`boards({ id }).page.get` method and its closed response DTO are installed in `@rezics/client`. After that
publication is available, replace the independent Board, Realm, thread-page and author reads only where the native
envelope supplies the same current fields. Do not hand-author or cast the client types, call the route directly, or
duplicate Content's producer.

Bind the generated errors, examples, and actual per-field availability through the existing Board loader and
`BoardPageCallerHost`, before Query success. Keep the actual-reader comparison, canonical slug ordering, explicit
invalid-cursor restart, query/session ownership and transfer adoption. Preserve the complete initial five-pin cohort,
advance only the ordinary source, keep sparse `next` pages, and retain only the selected page plus bounded return
descriptor. Exact retry repeats the same cursor, source, viewer and operands.

Render the admitted Board and containing community presentation and rules, then feed current `ThreadView`, author,
media, reaction and action-advice fields to existing Board cards and shared actions. Keep unknown counts, unavailable
viewer state, concealed identity/context, exact original context, and terminal summaries distinct. Commands continue to
reauthorize in their existing owners; no readable Board grants participation or moderation. Keep the current preview
bounds and author-declared spoiler reveal behavior.

Add authentic generated-response consumer tests for populated, withheld and failed responses, five pins plus twenty
ordinary candidates, concealed/overlapping pin identities, repeated authors, ordinary continuation, empty-plus-next,
exhaustion, all three sorts, invalid cursor and pin ABA, rank unavailability, optional context failure, signed-out,
nonparticipant and moderator states, zero versus omitted reactions, denied actions, thread return, exact retry, and
viewer/session/locale/source replacement with late responses. Preserve existing Board and shared-action oracles.

Add named stories for current opening, concealed optional context, zero/unknown interactions, sparse continuation,
invalid-cursor restart, denied actions and unavailable retry. Review only these states at 390px and 1280px in light and
dark themes, by keyboard and across all eight locales. Measure selected cohorts 1/10/25 while varying unrelated Board
size; report request count, rows, bytes and retained page state. Web response fixtures do not certify Content's
physical 256/1024/4096 growth, nested authority or hydration witnesses. Keep the independent-cache first-paint limit
truthful.
