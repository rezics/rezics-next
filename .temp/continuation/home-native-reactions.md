---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'interface',
  'riskAreas': [],
  'criticalPath': false,
  'after': ['76757ffe-9b2f-493d-8b9c-0290b81c6c6f'],
  'waiting': [],
  'paths':
    [
      'apps/web/src/features/pages/home-feed.tsx',
      'apps/web/src/features/pages/home-feed-read.ts',
      'apps/web/src/features/feed/home-feed-item.tsx',
      'apps/web/src/features/feed/home-reaction-admission.ts',
      'apps/web/src/features/feed/home-reaction-currentness.tsx',
      'apps/web/src/features/feed/README.md',
      'apps/web/messages/en.json',
      'apps/web/messages/zh-Hant.json',
      'apps/web/messages/zh-Hans.json',
      'apps/web/messages/ja.json',
      'apps/web/messages/ko.json',
      'apps/web/messages/de.json',
      'apps/web/messages/fr.json',
      'apps/web/messages/es.json',
      'apps/web/src/stories/home-native-reactions.stories.tsx',
      'apps/web/tests/home-native-reactions.test.tsx',
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
          'tests/home-native-reactions.test.tsx',
          'tests/thread-reactions-lifetime.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'Bind only generated FeedContentSummary reactionTarget, reactions, viewerReaction and page reactionsAsOf when actually installed; use the supplied target discriminant and target ID, never summary.id or an opening-post guess.',
          'Project the bounded supplied baseline without mount reads or per-row hydration; distinguish known empty counts, unavailable projection, anonymous omission and signed-in null.',
          'Keep select/switch/clear, refusal rollback, unknown retry/readback and source-watermark reconciliation in the existing ThreadReactions engine; retire stale page, target, source and viewer observations immediately.',
          'Cover 1/10/20 rows, duplicate targets and mixed unsupported kinds with zero mount reaction reads and no extra per-row requests; keep the native 20-row, 160-candidate and one-mixed-round boundaries unchanged.',
          'Add connected prepared stories for phone 390 and desktop 1280 in light/dark with anonymous and current-viewer states, exact counts, unavailable counts, target mismatch and replacement/revocation; do not claim prepared fixtures prove native delivery.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 1800, 'files': 16 },
}
---

# Receive native reactions on Home cards

The shared reaction and reply-count inspection work is complete. Home reaction receiving remains until the normal producer/client publication path installs the generated fields. The current generated Web contract still omits `reactionTarget`, `reactions`, `viewerReaction` and page `reactionsAsOf`. Bind those exact generated fields through `KernelClient` once published; do not add a browser DTO, cast, guessed target or generated declaration by hand. Keep Home reactions unavailable while they are absent, and preserve anonymous omission versus authenticated `null` when the viewer slot arrives.

Complete the current-reader Home visit across admitted post, reply, discussion and review variants only when the native union supplies an actual target. Keep selection, rollback, unknown recovery and point-read ownership in the installed reaction engine. Bind each page baseline and continuation to the current read, stream/filter, Space, target, source watermark and viewer/session observation; replacement or retirement must remove old private state immediately. Keep the bounded native page and candidate limits unchanged.

The full original acceptance still owns connected phone/desktop inspection of Home and Board, and the returned-revision suites remain under normal verifier custody. Source review and prepared stories do not establish native or rendered delivery.
