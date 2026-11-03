---
{
  "goal": "web",
  "manager": "web",
  "kind": "interface",
  "riskAreas": ["authorization", "disclosure", "rights", "account", "deletion"],
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "paths": [
    "apps/web/src/community/realm-bans.ts",
    "apps/web/src/community/realm-bans-control.tsx",
    "apps/web/src/community/realm-bans-panel.tsx",
    "apps/web/src/community/realm-ban-lifetime.ts",
    "apps/web/src/community/realm-ban-lifetime.md",
    "apps/web/src/community/realm-ban-current*.ts*",
    "apps/web/src/community/realm-ban-current*.md",
    "apps/web/src/community/space-actions.ts",
    "apps/web/src/stories/realm-ban-current-review.stories.tsx",
    "apps/web/tests/realm-ban-current*.test.ts*",
    "apps/web/messages/*.json",
    "docs/goals/web.md"
  ],
  "acceptance": {
    "command": ["bun", "apps/web/scripts/focused.ts", "--private-network", "--", "bun", "test", "tests/realm-ban-current-review.test.tsx"],
    "placement": "default",
    "tests": [
      "The installed composed page renders permitted disclosed target/moderator identities, safe concealed/erased fallbacks, supported destination, actual reason/time and current native action advice without suppressing operational rows.",
      "One exact selected-account inspection binds Realm, account and current ban episode, leaves the list cursor unchanged, and distinguishes absence, denial and unavailable states; unban readback confirms absence without promising membership restoration, and reban shows a new episode.",
      "Existing ban/unban writers preserve immutable uncertain intent, native reauthorization, protected-role refusals, accepted-removal versus completed-membership meaning, and independent definitive receipts when readback is unavailable.",
      "Sparse pages, same-cursor retry and explicit restart remain usable; account/CSRF/Realm/locale/exposure/source replacement retires private facts, selections and late effects; departure retains Stay/Leave semantics.",
      "At 1/10/20 rows actual adapters remain bounded with no per-row identity or permission fetch; native current-interval/history and growth remain producer evidence."
    ],
    "failing": true
  },
  "estimate": {"lines": 2200, "files": 18}
}
---

# Finish the current Realm ban review

The existing Web list now presents the installed native row fields with safe account-ID fallbacks. Complete the feature
after Content installs the generated current identity/action/inspection composition and native examples. Bind only the
installed methods and exported response types; do not guess fields or routes, copy source-only DTOs, add direct fetch,
or move native disclosure, authorization, mutation or membership-completion custody into Web.

For the composed current page, render permitted target and moderator identity, supported destination, actual reason and
effective time. Concealed or erased identity must use its admitted fallback while the authorized operational row stays
visible. A native null actor keeps its erased meaning. Identity presence never grants authority, and no row causes an
Accounts lookup or permission read.

Keep the native page limit at 20, native account-key ordering, opaque cursor and explicit same-input retry/restart. Sparse
empty pages with a continuation remain distinct from exhaustion; failed reads never imply zero bans. One selected current
account can be inspected outside the visible page without moving its list frontier. Bind the review and confirmation to
Realm, account and the actual current episode/effective observation. A changed observation cancels stale confirmation.
Unavailable inspection retains selection for explicit retry and never certifies absence.

After unban, preserve the definitive command receipt separately from readback. Native current absence means only that the
operational ban is absent. It does not restore membership, joins, follows or workflow completion. A non-null ban workflow
reference remains removal pending until Accounts reports completion. Reban displays the new episode and current advice,
never the previous page's reason or actor.

Preserve the current writer's exact immutable uncertain intent, original credentials and idempotency key, native command
reauthorization, protected-role refusal and conflict behavior. A read cannot resubmit, abandon or replace uncertain
intent. Caller retirement on Realm, viewer/actor, CSRF, QueryClient, locale, exposure, adapter/initial source, page or
episode replacement must fence late results and retire selections, drafts, confirmations and receipts. Preserve the
existing authoring Stay/Leave boundary and focus recovery.

Compose the installed adapter, default Panel/Control and QueryClient in focused tests using admitted native response
fixtures. Cover disclosed/concealed/erased identities, null actor, ordinary-reader denial, protected target refusal, 20
rows, sparse continuation, invalid cursor, same-input retry, outside-page selection with stable cursor, absence after
unban, new reban episode, pending removal, unavailable readback, immutable unknown retry, duplicate activation, caller
replacement, departure and late settlement. Keep command, target and lifetime oracles. Stories cover current bans,
concealed moderator, selection, absence, reban, sparse page, pending removal, uncertain retry, denied and unavailable
inspection. Review phone 390 and desktop 1280, light/dark, keyboard, all eight locales, wrapping 44px actions, clear
current/history, original instant and focus recovery. Authored fixtures and stories do not prove native authority,
registered removal or producer growth.

Keep the active consumer bounds and exact Cost bullets in the owner document. Complete the 1/10/20 consumer growth check;
Content and Accounts retain native 256/1024/4096 current-interval, history, identity, authority and registered-completion
evidence. Keep acceptance, generated installation, rendered review and native evidence separate.
