# Web and Auth interfaces

## Outcome

People can discover, contribute, discuss, collect and buy through accessible, localized interfaces, using the same
capabilities and disclosure rules on every page and device.

## Done when

- The site and Auth applications run locally through documented commands. Routing, navigation, localization and
  shared UI/document components provide a usable shell in every launch locale.
- Every launch vertical has subject pages from shared definitions/composition, plus search, facets, typeahead,
  boards, threads, posting/replies and the scoped community, Zone, moderation and notification surfaces.
- Collections, the personal library, independent labels, holdings, progress and explicit publication are usable
  through their real APIs. Filters remain available wherever the common Collection abstraction appears.
- Checkout start/return and entitlements expose the commerce outcomes without treating a redirect as fulfilment.
- Auth pages support sign-in, sign-up, consent, security settings and step-up through the accounts contract.
- The session BFF, upload completion and every download preserve caller identity and current API decisions.
- Pages render useful preparation, empty, denied and unavailable states; metadata, sitemaps and sharing reflect only
  permitted public representations. Safe JSON-LD agrees with rendered content.
- Reviewed running pages and recorded-response stories demonstrate accessible phone/desktop layouts, both themes,
  representative content and all launch locales.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit. Specified,
implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.

## Scope

Includes `apps/web` and `apps/auth`, shared UI/document components, BFF/media transport, product routes, library
pages and SEO. Follow [public scope](../scope.md), [subject pages](../subject-pages.md) and [SEO](../seo.md).
Do not turn deferred feeds, recommendations or personal saved queries into implicit requirements. Backend contracts
stay with their product owners; preparation and privacy changes must remain visible in the interface.

## Ownership

Owns `apps/web/**`, `apps/auth/**`, `packages/ui/**` and `packages/document/**`.
[UI](../../packages/ui/README.md) and [document](../../packages/document/README.md) own shared components.
Search owns composition and presentation templates; agree named slots and sequence edits in shared page features.
Accounts owns Auth behavior; content owns media and communities; commerce owns library and checkout semantics;
semantic owns definitions and Zones. Correct shared visual defects as a class across consuming surfaces.

## Dependencies

Requires the typed kernel client and real owner APIs, exposure discovery, BFF sessions, definition releases,
presentation profiles and composition slots. Use typed fakes only as interim implementation aids; recorded fixtures
must be refreshed with their producer changes. A fake alone cannot prove authorization or native API behavior.

## Acceptance

Run focused interface and integration suites through the owning app/package check runners. Connect native
[page outcomes](../../specs/pages-outcomes.test.ts), [search outcomes](../../specs/search-outcomes.test.ts),
[library outcomes](../../specs/library-outcomes.test.ts) and [media outcomes](../../specs/content-media-outcomes.test.ts)
to their corresponding running pages. Review screenshots and Storybook evidence in all launch locales, both themes
and phone/desktop layouts. Include keyboard access, loading, empty, preparing, unavailable and hidden-resource
states. [Verification](../development/verification.md) owns commands and review cadence; automated assertions do not
establish visual quality. A full web check is required only when the task contract names it.

## External conditions

Production Worker bindings, object storage, abuse prevention and deployment configuration must be supplied through
supported interfaces. Private provisioning is external; functional and visual acceptance uses isolated fixtures.
