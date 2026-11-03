---
{
  'goal': 'commerce',
  'manager': 'commerce',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/library/list-import-anilist*',
      'services/kernel/test/library/list-import-anilist*',
      'services/kernel/src/http/kernel.ts',
      'packages/client/src/kernel/library/list-import-anilist*',
      'docs/library-import-anilist.md',
      'docs/goals/library.capabilities.md',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'deletion', 'account'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'estimate': { 'lines': 650, 'files': 6 },
  'acceptance':
    [
      'Content exposes an atomic guarded native vote command that binds question revision, current counted vote or absence, canonical/counting identity and local correction before receipt lookup or mutation.',
      'AniList applies only the reviewed, separately confirmed vote or explicit clear through the actual Content writer and its receipt/component result; retries retain original operands and key.',
      'Question changes, counted-vote changes, target identity changes, local corrections, cancellation, lost acknowledgement, foreign ownership and terminal denial have focused coverage.',
      'Generated AniList requests/results are consumed by Web325 without a second interface, casts or handwritten client types.',
    ],
}
---

# Complete native AniList score admission

An owner can explicitly adopt one retained AniList score as a native vote, choose native units without a guessed
conversion, confirm its public and aggregate effects, and see the actual native outcome. Importing state alone leaves
votes unchanged. Preserve an existing vote by default, keep zero, clear and absence distinct, and refuse stale
question, counted-vote, identity or local-correction observations. A lost acknowledgement retries the original
native command key and operands without reading a replacement vote under that key.

The installed Content `createVoteCommands.putVoteOutcome(actor, {questionId, targetId, units}, idempotencyKey)` does
not yet accept or enforce the required review guard. Keep AniList score plans typed unavailable until Content's
conditional producer is installed. Finish the private current-vote/absence review and canonical/counting identity
binding, then invoke that owner command and return only the vote data and component Content permits. Keep all current
AniList row, upload, page, lifetime and cleanup bounds. Preserve its typed source evidence and apply the selected
confirmed score action without changing other imported fields. Update the source contract and capability inventory
with measured behavior, and deliver the generated interface to Web325.
