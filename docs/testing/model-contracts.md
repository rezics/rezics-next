# Model and reference acceptance

The 27 MODEL scenarios and required results are declared in
[typed cases](../../scripts/qa/cases/model-contracts.ts). This page remains the
case source path in the frozen QA inventory; moving that path requires a reviewed
backend-scope fingerprint change. [Recorded qualification](../plan/qualification.md)
identifies the full clean run and exact tests that passed each case. The compiler
[candidate tests](../../model/compiler/generate.test.ts),
[native equivalence tests](../../model/tests/native-equivalence.test.ts) and
[validation guards](../../tests/qa/unit/validation-guards.test.ts) have narrower
individual scopes; reference-validator output alone does not qualify Jena.

## Earlier bounded evidence

These selected runs preceded the full recorded qualification and establish their
own profiles, not arbitrary Resource or relation operations:

- Work type creation and recovery: `20260925t200223-bfeed7`,
  `20260925t200335-f56474` (MODEL01/MODEL08 subset).
- Append-only author-credit adoption, native validation and held-graph recovery:
  `20260926t074730-1831a8`, `20260926t074739-acebf1`,
  `20260926t074730-20dab9` (MODEL05/MODEL06 subset).
- Six exact Work scalar states through API, graph, export and recovery:
  `20260926t130425-0fa17d`, `20260926t131838-6836e6`,
  `20260926t131053-03fb93`; shape candidates:
  `20260926t131755-6d0a7c` (MODEL02 subset). These used image
  `rezics/fuseki:6.2.0-cmd0.5.29-scalar1`, config
  `sha256:7f20578694a47d3af2ee6fda6ceac3f2c162d7b6a3d85f88ff6741944e8c485a`.

The [editorial-protection subcases](../../scripts/qa/cases/editorial-protection.ts)
are additive requirements under existing MODEL IDs; their status is independent
of the recorded denominator. [Shared Context](../contracts/context.md) requires
exact scoped definitions, independent semantic and preference revisions, and
unavailable outcomes without fallback. Inspect the named tests and their receipts
before expanding either claim. Record inputs, profile/build identities and
failures; mock-only evidence cannot qualify storage or cross-owner behavior.
