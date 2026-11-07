---
goal: web
manager: content
kind: implementation
paths:
  - apps/web/scripts/storybook-dev.ts
  - apps/web/scripts/messages-ready.ts
  - apps/web/scripts/web-startup.ts
  - apps/web/scripts/storybook-dev.test.ts
  - apps/web/vite.config.ts
  - apps/web/tests/support/vite-dep-cache.ts
  - apps/web/tests/vite-config.test.ts
  - apps/web/tests/with-dev-server.test.ts
  - apps/web/README.md
---

# Web native startup receiving

## Resume condition

Performance identifies the first Worker boot failure or readiness trace and integrates a supported repair. The Web
startup producer, focused regression coverage and receiving gate are already integrated in the base. The owner
decision remains in `apps/web/README.md`; do not repeat the unchanged native launch before the repair.

## Remaining work

After the repair is integrated, rerun the retained Auth/Web native check with its original 270-second fixture deadline
and attempt-owned cancellation. Preserve the original log. Confirm the real Worker reports ready, then verify the
installed Vite child reaches listening and returns useful `/en` after both fresh and reused message preparation.
Record the received startup result in `apps/web/README.md`. Keep browser, growth, money and promotion evidence
separate.
