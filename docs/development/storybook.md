# Storybook for web and UI

Storybook is the review catalogue for interfaces on recorded or clearly identified fake responses. It proves how the
interface renders and behaves for those fixtures. It does not prove authorization, disclosure, indexing cost, or
lifecycle behavior; native API acceptance proves those outcomes.

## Catalogue and ownership

The web sidebar starts with **Review**, then **Pages** with **Library** first, followed by the other page groups in
this order: Subjects, Discovery, Community, Commerce, Account. Other groups follow Pages. The composed UI catalogue
lists its own components first and `shadcn` last. Keep story titles stable because they form deep links; when a title
must change, set an explicit `id` to preserve the existing link.

Shared components live beside their code in `packages/ui`. Connected patterns and pages live in `apps/web`. The
[page story coverage map](page-stories.md) is the ledger: a story reference covers only the named outcome it renders;
`missing` means no page story exists; `planned: <dependency>` names an API capability that does not exist yet. A
recording that fabricates a missing outcome is never coverage.

## Interface brief checklist

Every interface brief follows this checklist:

- State the user outcome, owner documents, affected routes and shared consumers, and stable IDs to preserve.
- Name each story export, persona, state, disclosure expectation, fixture source, and backing API status.
- Use typed CSF3 stories with a small set of meaningful states and deterministic fixtures with cleanup.
- Put each story beside its owner: shared UI component, connected web pattern, or route page.
- Assert the user-visible result with accessible role and name queries, awaited events, and keyboard coverage.
- List screenshot tuples, risks, accessibility checks, visual reviewer, exact acceptance and scoped check commands, and cost bounds.

## Screenshots and interactions

For each changed page or shared pattern, choose one reference state and review it in all eight launch locales (`en`,
`zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`, `fr`, `es`) at widths 390 and 1280 in light theme, plus `en` and `ja` at
both widths in dark theme. Review every other state in `en` and `zh-Hans` at both widths in both themes, plus its
risk cases: long German or French on a phone, a CJK title with a missing cover on a phone, dark overlays, and a
permission or preparing state on a phone. Check 320-wide reflow by eye for each new layout pattern. Theme defects
do not depend on locale; locale defects depend on width, so run all locales at both widths in the reference theme.

The Vitest addon is the only interaction runner. Play functions assert the outcome with role and name queries and
awaited events; they never sleep. Accessibility violations remain errors, including inside open menus, dialogs, and
expanded filters.

There is no screenshot baseline suite yet. Review visual quality by eye on the published build of the reviewed commit
while the interface is being reworked; baselines would churn with intended changes. Revisit baseline testing when the
first public scope's interface is stable.

## Cost: static review catalogue

- Touches: one web build, one composed UI build, story indexes, docs pages, and build metadata.
- Bound: build each catalogue once per reviewed commit and reuse that artifact for smoke review and publication.
- Growth check: record build time and output bytes before and after catalogue changes.
