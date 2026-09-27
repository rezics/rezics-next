# Cross-service acceptance

The [typed SYS01–SYS14 inventory](../../scripts/qa/cases/backend-integration.ts)
defines the scenarios and required results. This page remains the stable case
identity in recorded qualification evidence. The [qualification record](../plan/qualification.md)
links each case to its actual unit, integration, model or fault/recovery tests;
the case title alone does not prove every assertion.

Run cross-owner fault cases in the applicable isolated QA tier. Capture owner
receipts, exact profiles and builds, failed boundaries and recovery results.
Mock-only results do not qualify storage or cross-service behavior.

The [authenticated API journey](../../tests/qa/integration/authenticated-api-journey.test.ts)
exercises Account tokens, Access grants, Main commands, Content revisions and
public search through real owner APIs. Its result is qualified by its own run.
