# REZICS Goal

Status: started on 2026-09-30, when the maintainer asked to push it as far
toward completion as the current usage cycle allows (Claude resets 2026-10-05,
the Codex accounts 2026-10-06 and 2026-10-07). GPT-6.1 Sol continues the stopped
G-432, G-433 and G-435 and runs G-486; M4 starts with G-536. The previous
frontend-centred Goal paused after M3 at `59a85a96`. Backend phase 1 finished on
2026-09-27: recorded run `20260927t101230-1616d8`, local tag
`goal/backend-phase1`, history on `archive/goals`.

## Outcome

Make REZICS complete and ready for production.

**Complete** means each supported job can be discovered, completed, confirmed,
revisited, recovered and exported through authorized APIs and an accessible
browser experience, on phones as on desktops, at the quality GitHub, Reddit,
Fandom and Notion set for the same job. Their combined inventories are benchmarks,
not scope. The API is the complete experience; the UI simulates it for people;
every capability is accepted through both. The
[product scope](docs/product/capabilities.md#first-scenarios) owns the four first
scenarios and the longer-term knowledge, creator and distribution direction.

**Ready for production** means deployment to the prepared fleet is operations
work. Deployment is the next phase; the
[deployment owner](docs/operations/deployment.md#ready-to-deploy) records readiness.
Intended registration markets are the United States, Taiwan, Singapore, Japan,
South Korea and the EU, subject to the
[market and safety gates](docs/operations/trust-and-safety.md#safety-and-legal-readiness).

## Decisions

Stable references to decisions made on 2026-09-29. Each owner records the
decision-maker, reason and evidence; these are intent, not completion claims.
The maintainer may revise them. Durable decisions live in their owners when
this Goal is replaced.

### Trust

1. <a id="decision-1"></a>[Suitability and disclosure](docs/contracts/classification-judgments.md#suitability-and-disclosure).
2. <a id="decision-2"></a>[Safety and legal readiness](docs/operations/trust-and-safety.md#safety-and-legal-readiness).
3. <a id="decision-3"></a>[AI disclosure and consent](docs/contracts/license-grants.md#ai-disclosure-and-consent).
4. <a id="decision-4"></a>[Visible is not permitted](docs/contracts/identity-and-access.md#visible-is-not-permitted).
5. <a id="decision-5"></a>[Launch shape](docs/operations/deployment.md#launch-shape).

### Foundations

6. <a id="decision-6"></a>[Explicit identities, targets and units](docs/contracts/work-and-release.md#explicit-identities-targets-and-units).
7. <a id="decision-7"></a>[One native-language contract](docs/contracts/content-languages.md#one-native-language-contract).
8. <a id="decision-8"></a>[One authority model](docs/contracts/identity-and-access.md#one-authority-model).
9. <a id="decision-9"></a>[One disclosure and enforcement policy](docs/operations/security.md#one-disclosure-and-enforcement-policy).
10. <a id="decision-10"></a>[Durable custody](docs/contracts/main-version.md#durable-custody).
11. <a id="decision-11"></a>[Main owns business tasks](docs/contracts/events-and-jobs.md#main-owns-business-tasks).
12. <a id="decision-12"></a>[Complete traversal](docs/contracts/queries.md#complete-traversal).
13. <a id="decision-13"></a>[Meaning survives every adapter](docs/product/design-principles.md#meaning-survives-every-adapter).
14. <a id="decision-14"></a>[Executable capability registry](docs/contracts/api.md#executable-capability-registry).
15. <a id="decision-15"></a>[Types restricted, vocabulary open](docs/contracts/classification.md#restricted-structure-and-open-vocabulary).

### Experience

16. <a id="decision-16"></a>[Simple, Advanced and reserved Agent mode](docs/plan/frontend.md#presentation-modes-and-settings).
17. <a id="decision-17"></a>[Classification journeys](docs/contracts/classification.md#classification-journeys).
18. <a id="decision-18"></a>[Multilingual search](docs/contracts/search.md#multilingual-retrieval-direction).
19. <a id="decision-19"></a>[Collaboration at GitHub’s level](docs/contracts/editorial-protection.md#shared-collaboration-lifecycle).
20. <a id="decision-20"></a>[Community at Reddit’s level](docs/contracts/community-interactions.md#community-completeness).
21. <a id="decision-21"></a>[Creators](docs/contracts/creation.md#creator-experience).
22. <a id="decision-22"></a>[Documents on BlockNote](docs/contracts/presentation.md#document-editor-choice).
23. <a id="decision-23"></a>[Knowledge workspace](docs/contracts/information-verification.md#knowledge-workspace).
24. <a id="decision-24"></a>[Agents through one open contribution protocol](docs/contracts/skills-and-prompts.md#open-agent-contribution-protocol).
25. <a id="decision-25"></a>[Developers and phones](docs/contracts/api.md#developers-and-phones).
26. <a id="decision-26"></a>[Imports through the API; functional tests only](docs/contracts/source-lifecycle.md#import-rollout).
27. <a id="decision-27"></a>[Libraries first](docs/product/design-principles.md#libraries-first).

### Growth and revenue

28. <a id="decision-28"></a>[Worldbuilding](docs/contracts/creation.md#private-worldbuilding).
29. <a id="decision-29"></a>[A big-franchise wiki for every Work](docs/contracts/information-verification.md#a-big-franchise-wiki-for-every-work).
30. <a id="decision-30"></a>[Creator distribution](docs/contracts/distribution.md#creator-distribution).
31. <a id="decision-31"></a>[Recognition, points and credit](docs/product/markets-and-growth.md#recognition-points-and-credit).
32. <a id="decision-32"></a>[The about site wins users](docs/product/markets-and-growth.md#about-site).
33. <a id="decision-33"></a>[Developer extras, non-core](docs/contracts/connected-apps.md#first-party-sessions-and-developer-extras).

#### Platform thesis

34. <a id="decision-34"></a>[The vertical engine is the product](docs/product/platform-thesis.md#the-vertical-engine-is-the-product).
35. <a id="decision-35"></a>[One graph, many language fronts](docs/product/platform-thesis.md#one-graph-many-language-fronts).
36. <a id="decision-36"></a>[Beat the weakest incumbent with cost](docs/product/markets-and-growth.md#beat-the-weakest-incumbent-with-cost).
37. <a id="decision-37"></a>[Hype only what works](docs/product/markets-and-growth.md#hype-only-what-works).
38. <a id="decision-38"></a>[AI speed through open interfaces](docs/contracts/skills-and-prompts.md#ai-speed-through-open-interfaces).

Settled research, also adopted on 2026-09-29:

- R30: [URLs and SEO](docs/product/urls-and-seo.md).
- R34: [Vertical manifests and the four-hour acceptance test](docs/product/platform-thesis.md).
- R35: [First verticals](docs/product/markets-and-growth.md#first-verticals).
- R36: [Release-to-return event loop](docs/product/markets-and-growth.md#release-to-return-loop).

## Milestones

The manager revises them. A milestone counts only when merged, its checks pass,
its journeys pass through the API and in a real browser against the local stack,
and the `product-audit` skill finds no open P0 or P1 class in its area.

- **M4 Meaning, authority and preservation.** Foundations 6–8 and 13, the
  suitability model, document identity and operation contracts; repair date
  loss, empty saves, public draft covers and private-name publication; the
  catalog gate and the persisted-profile check. Exit: counterexample fixtures
  pass; simple edits keep richer state; denied and revoked operations fail
  correctly; the language and profile guards fail on deliberate regressions.
- **M5 Shared capabilities and safety.** Foundations 9–12 and 14: indexed
  traversal, shared query execution, resumable operations, document recovery,
  scoped grants, reporting, enforcement and appeals, upload clearance,
  principal budgets, the registry and its adapters. Exit: inventories traverse
  past every former bound; a retried operation has one effect; policy holds on
  every channel; pending contributions and legal cases reach real outcomes.
- **M6 The vertical engine, the four scenarios and the first verticals.** The
  [shared engine](docs/product/platform-thesis.md), configurable through both
  the API and an administrator UI;
  then, as configuration on it: library import, sessions and export; series,
  edition and availability tracking; serial drafting, scheduling, reading and
  discussion; VN discovery by release; the Light Novels and ACGN Zones with
  episode tracking on the shared progress foundation; and the LLM index with
  ratings as the engine's proof. Exit:
  paired API and browser journeys pass with ambiguous editions, expired loans,
  mixed formats, non-UI languages, thousand-chapter inventories, revoked
  editors, interrupted exports and two-device progress; the
  [four-hour unanticipated-vertical test](docs/product/platform-thesis.md#first-manifests-and-proof)
  passes from configuration alone.
- **M7 Contribution, knowledge and assistance.** Classification and
  corrections, the review lifecycle, subscriptions and inbox, community
  completeness, settings and modes, saved views, the editor and Realm wikis,
  developer onboarding and non-core developer extras, worldbuilding and the
  first wiki-builder pilot, the agent platform with the first-batch agents, and
  distribution's first scope behind the payment gate. Exit: propose, review, revise, decide, notify and recover work
  end to end; changed candidates invalidate approval; historical wiki rendering
  and export survive dependency changes; replacing an assistant keeps its
  authorized artifacts.
- **M8 Production qualification.** Deployment artifacts, production bootstrap
  and the launch catalogue, timed recovery, security review, email operations,
  legal configuration within the zero-budget decision, safety drills,
  privacy-preserving measurement, real-device and accessibility acceptance,
  and Stripe's approval before any sale. Recognition ships here; points and
  credit follow launch. Exit: no open P0 or P1 class or
  High security finding; launch workloads meet budgets; recovery and takeout
  demonstrated; every supported capability has acceptance evidence; market
  gates and named responders ready.

Counsel, staffing, catalogue supply and device testing start alongside M4.
After M4's contracts settle, language and search, authority and safety, and
documents and operations run in parallel; in M6 the scenarios run in parallel
against the shared contracts.

## Completion

The Goal ends when the maintainer stops it, or when M8 passes its exit and the
maintainer agrees.

## Constraints

The manager's authority and the maintainer's standing directions are in the
[manager charter](docs/goals/manager.md). Other documentation records practice
to consult, not rules. The manager runs workers through the
[Goal program](docs/goals/README.md), and workers follow the
[worker protocol](docs/goals/worker.md).

The [deferred rollout scope](docs/product/capabilities.md#deferred-rollouts) stays
outside this delivery. Code, schemas and tests own executable behaviour; the
linked documents own lasting intent, reasons and operating procedures.
