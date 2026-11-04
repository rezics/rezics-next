---
goal: content
manager: content
kind: claim
paths:
  - apps/web/src/accounts/public-profile/contribution-actions/**
  - apps/web/src/accounts/public-profile/contributions/row.tsx
  - apps/web/src/accounts/public-profile/contributions/README.md
  - apps/web/src/accounts/public-profile/page.tsx
  - apps/web/src/accounts/public-profile/view.tsx
  - apps/web/src/features/pages/account.tsx
  - apps/web/src/routes/@{$handle}_.$view.tsx
  - apps/web/tests/public-contribution-actions*.test.tsx
  - apps/web/src/stories/public-contribution-actions*.tsx
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - c023b977-fc2f-48a4-8bcf-77e0995f4282
  - b20c4b9c-6b6d-4b1f-bd6f-3cff3600ce43
  - c1e3cdb6-e3af-4e74-96a4-e858d16c591d
  - e27d5886-80a4-4a23-8a94-10a2ed65726c
  - 717dd15a-ecc2-4374-90e3-fc8f56297133
  - 0b1f322f-8123-476a-8093-2af11583c3e7
  - 64856b3e-c5ad-4e01-92a3-a0df1b9553c3
  - d7615d61-fbfe-4b0f-9cd6-1c168186b123
  - fc61a92e-ab1e-4120-a0db-31e2772c2c65
  - c294ebf5-c2e1-4974-b829-9f64a0b047c8
  - 868380ae-4919-4791-9761-fa6e839304e4
  - e9314e51-a782-43e9-b55a-017dcc1bac53
  - 90ef7471-efae-4d11-a6dc-9b4afcab9429
  - a215aba0-bad6-4042-8b92-29d1af5f2756
  - 94c0f3af-308c-4d39-b118-f856b87480c1
  - a47daa6e-d523-4428-ad36-1ab9ce6ce22a
  - 97ae47b1-81e8-43f7-b2a1-dd0343d940f2
waiting: []
acceptance:
  tests:
    - "The closed response adapter consumes only the installed public author-contribution DTO and exact advice; absent own slots and sparse pages remain absent."
    - "Exact advice invokes existing reaction, containing-thread watch, report and safe reply owners; targets, frozen uncertain operands, retries and return focus remain owner-controlled."
    - "Page, source, author publication, credential, QueryClient, locale and away/return replacement retire the host and all controls."
    - "Only sparse, read-only, sign-in, failed, pending and uncertain stories exist, with keyboard and screen-reader checks at 390 and 1280 layouts."
  failing: true
estimate:
  lines: 900
  files: 11
---

# Finish connected contribution actions

The public page now mounts one private host over the original anonymous page selection and observes the page, source,
publication, credential, QueryClient, locale, row contexts and navigation lifetime. The production wire remains
unavailable: at the retained declaration head the installed client has no `author_contributions.actions` method or
DTO. Do not infer one or import private producer types. Finish the closed adapter and action presentation when the
complete-input publisher provides its public contract and installed typing.

Use exact advice to connect the existing reaction, containing-thread watch, report and safe reply owners. Preserve
the native thread/post/source/parent destinations, current composer, return focus, authorize-before-receipt order,
frozen sender/credentials/payload/key after uncertainty and same-key retries. Readback or aggregate watermark changes
cannot replace a missing receipt. Keep anonymous rows and native outcomes owned by the existing page/controller.

Add only the named sparse, read-only, sign-in, failed, pending and uncertain stories, plus the smallest focused
interaction tests for exact inputs, retirement, unavailable own slots, keyboard/screen-reader behavior, long text and
390/1280 layouts. Continue to build from installed public typings; keep native producer sources, fixtures and growth
measurements with their receiving owner.
