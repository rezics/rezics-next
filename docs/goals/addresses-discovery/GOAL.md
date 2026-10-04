---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch). Migrations are not listed:
# each task reserves its own numbers. Bracket and brace globs would overlap almost every path, so each prefix is listed.
areas:
  - services/main/src/modules/discovery/**
  - services/main/src/modules/feed/**
  - services/main/src/modules/rating/**
  - services/main/src/modules/space/**
  - services/main/src/modules/address/**
  - services/main/src/modules/follows/**
  - services/main/src/modules/notification/**
  - services/main/src/routes/addresses.ts
  - services/main/src/routes/resources.ts
  - apps/web/features/discover/**
  - apps/web/features/shell/**
  - apps/web/features/zones/**
  - apps/web/tests/direction-9*
  - apps/web/tests/g-100*
  - apps/web/tests/g-101*
  - apps/web/tests/g-102*
  - apps/web/tests/g-103*
  - apps/web/tests/g-104*
  - apps/web/tests/g-105*
  - apps/web/tests/g-106*
  - packages/ui/src/components/entity-picker*
  - packages/ui/src/components/sheet*
  - tests/qa/integration/g-93*
  - tests/qa/integration/g-94*
  - tests/qa/integration/g-95*
  - tests/qa/integration/g-96*
  - tests/qa/integration/g-97*
  - tests/qa/integration/g-98*
  - tests/qa/integration/g-99*
  - tests/qa/integration/g-100*
  - tests/qa/integration/g-101*
  - tests/qa/integration/g-102*
  - tests/qa/integration/g-103*
  - tests/qa/integration/g-104*
  - tests/qa/integration/g-105*
  - tests/qa/integration/g-106*
  - tests/qa/support/work-profile*
  - scripts/load/**
  - docs/product/urls-and-seo.md
  - docs/contracts/space.md
  - docs/contracts/community-interactions.md
  - docs/contracts/notifications.md
---

# Addresses, relationships and discovery

Status: running since 2026-10-02 (tasks G-937 onward). Split from the
[production-readiness Goal](../production-readiness/GOAL.md) on 2026-10-04,
when several Goals began to run at once; its manager continues unchanged.
[state.md](state.md) holds the checkpoint.

## Outcome

Maintainer, 2026-10-02: fix the foundations found missing, completely and by
best practice, before further surface work:

- durable addresses with optional names (sid, aliases and a readable suffix);
- separate community and site routers (`/r` and `/z`);
- one Follow, Join and notification model, with the notification bell and
  membership;
- Discover as one browse over every resource type;
- searchable, traversable pickers wherever a collection is unbounded (ratings
  scope, Topics, wiki position).

Maintainer, 2026-10-03, added the alias vocabulary, dropping the `NameRow`
display, and API performance measured with OpenTelemetry against the
[cost models](../../testing/complexity.md#api-request-work-profiles): the Home
and Realm feeds, search, Discover, the rating and Discover projections, long
Works and write paths.

The manager leads and reviews; GPT-6.1 Sol carries the implementation, frontend
included. Subdomain hosting stays a draft. The decisions live in their owners:
[URLs](../../product/urls-and-seo.md), [Space](../../contracts/space.md),
[interactions](../../contracts/community-interactions.md),
[notifications](../../contracts/notifications.md) and
[frontend](../../plan/frontend.md).

## Completion

The Goal ends when its outcome passes through the API and in a real browser
against the local stack, its performance work meets the cost models, and
`task goal -- goal close addresses-discovery` finds nothing of it left in the
tree. What it decided stays in the owner documents above.
