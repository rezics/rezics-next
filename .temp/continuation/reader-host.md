---
goal: web
manager: content
kind: implementation
paths:
  - apps/web/src/session/**
  - apps/web/src/reader/**
  - apps/web/src/routes/**
  - apps/web/tests/thread-reader-boundary.test.tsx
---

# Attach reader navigation to the shared session host

Performance's shared session provider is not publicly exported in this base. When that provider is delivered,
reconcile its host through the train; do not rebase or add a duplicate session provider.

Owner: [supported reader lifetime](../../apps/web/src/session/README.md#supported-reader-lifetime).
Contract: `apps/web/src/reader/lifetime/contract.ts` exports `ReaderNavigation` with only `address` and `subscribe`.
Supply that capability once through the existing `ReaderNavigationContext` from the shared host, preserving the
optional Router and Router-free fallbacks in `apps/web/src/reader/lifetime/navigation.tsx`.

Keep session state, fetches and QueryClient observation in the session owner. Keep native authority, uncertain
command operands and focus in feature owners. Existing acceptance is `apps/web/tests/thread-reader-boundary.test.tsx`:
equal session replacement, account ABA, isolated mounts, host departure and optional Router cursor departure.
Add one host integration case when its public provider can be imported, proving synchronous retirement before
page replacement and one shared cache observation per QueryClient. Run the changed workspace typecheck through
the worker-check wrapper; broader acceptance belongs to the dev verifier under minimal verification.
