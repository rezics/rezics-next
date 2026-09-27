# Steam Workshop acquisition

Deferred by the maintainer on 2026-09-27; low priority.

## Current state

PKG11 is qualified as a relation-modeling case: records authored in the Steam
Workshop shape (required-item children and Collection membership) pass through
the real receipt path without inventing a mandatory installation constraint.
Collection membership is also captured live through a keyless endpoint. Live
capture of an item's required items is skipped. The API-key path
(`REZICS_STEAM_WEB_API_KEY`) stays available as an optional advanced-user
configuration; users are never required to supply a key. See
[package cases](../../../scripts/qa/cases/packages.ts).

## What was learned

- [`ISteamRemoteStorage`](https://partner.steamgames.com/doc/webapi/ISteamRemoteStorage)
  `GetPublishedFileDetails` and `GetCollectionDetails` take no key. A probe on
  2026-09-27 against item `2023507013` (which requires Harmony, `2009463077`)
  showed that `GetCollectionDetails` returns result 9 for an ordinary item and
  `GetPublishedFileDetails` returns no `children`, so the keyless API does not
  expose an item's required items.
- `IPublishedFileService/GetDetails` with `includechildren` returns children but
  [requires a Web API key](https://gist.github.com/BadgerCode/180d9b361af0c8a5c9b9d98c51f720ac).
  Any Steam account in good standing can obtain one at no cost, so a single
  server-side key held by the operator would serve every user.
- The public Workshop item page lists required items in its `RequiredItems`
  block (the same probe found Harmony there). Reading it needs no key but
  depends on HTML that can change, needs rate limiting, and its fit with Steam's
  terms is unconfirmed.

## Open decision

Whether the platform operator holds one server-side Steam Web API key for
required items, or whether required items come from the Workshop page with rate
limiting and fallback, or stay out of scope.
