# Identity and reader preparation handoff

G-2791 owns the single genuine corpus and retained backup; G-2778 owns importer
wiring. This handoff extends their existing preparation. It authorizes no new
importer, source substitution, refresh or reset. The independent assertions and
support fixture remain with their existing owner.

Source inspection at `f14fae6aa6ab96344a444f73ff0f104204540371` confirms the
historical Book `beforeAll` failure was the unsupported final
`work-structure-publication-v1` command in `createBook`, not a reached reader
assertion. `book-composition` has no Work Structure publication profile. Do not
enable one or relax public/source authority to repair that fixture.

The supported public Book command sequence is the existing sequence in
[createBook](../../../tests/qa/support/identity-reader-fixture.ts), ending
before its final `/v1/work-publications` call:

1. Use an activated Account and represented Agent with recovery and `work.create`
   gates open. `POST /v1/works` with `metadata-only-v1`, Book type and `own-work`,
   then `POST /v1/compositions` with `book-composition` and its returned Main Version.
2. `POST /v1/contributions` with `text-contribution-v1`; publish its exact draft
   through `/v1/contribution-publications` with `text-publication-v1`, original
   contribution rights and public disclosure. Select that publication through
   `/v1/publication-selections` using this closed public shape:

   ```json
   {
     "profile": "main-default-selection-v1",
     "context": { "kind": "main-version-default", "id": "<returned Main Version>" },
     "work": "<returned Work>",
     "contribution": "<returned contribution>",
     "publicationDecision": "<returned current public publication decision>",
     "expectedSelectionHead": null,
     "selectionBasis": "main-maintainer",
     "actingSubject": "<represented Agent>"
   }
   ```

   For replacement, use the current selection head in `expectedSelectionHead`.
   The owner resolves draft and language from the selected publication and
   fences the Main head internally. The earlier local handoff's
   `expectedMainRevision`, draft and language command fields were incorrect.
   The existing `createBook` selection command already has the correct shape.
   The current public Main text selection is the Book-level prerequisite;
   independently published chapters do not publish the Book.
3. Create each chapter through `/v1/works/:id/chapters`, `book-chapter-create-v1`,
   carrying the previous returned `expectedCompositionHead`. Save native
   `/v1/content-drafts`, publish the exact revision/digest/Content epoch through
   `/v1/content-publications`, then bind public `/v1/content-search-eligibility`
   to that current publication decision. Preserve returned Work, Structure,
   occurrence, Post, variant, revision, digest and source positions.
4. Stop there for Book. Its normal public header, contents, chapter, exact
   Content and Main default links must agree on the returned identities.

Recipe uses its supported reviewed Work Structure publication with the exact
revision/generation/root and genuine original or source correspondence. Retain
the existing source observations, attribution and current rights assessments;
the original Book command example supplies no rights for an imported Recipe.

The manager's current-product isolated proof authorization supersedes the old
obsolete-baseline prerequisite. Reuse only the sole producer's compatible
genuine data and backup. Later proof selection retains both independent files:
`tests/qa/integration/outcomes/realm/identity-discovery.test.ts` and
`tests/qa/integration/audit-public-reading.test.ts`, all six personas, the empty
Account, foreign Account isolation, replay/clear/next, exact body/navigation,
publication/disclosure/rights revocation and the seven invalid-bearer surfaces.
Preparation failures reach no outcome assertions. Code and stack-free owner
regressions alone do not close D4-007 or D4-008.

The current wave now provides that preparation in the existing launch owner:
`task launch:corpus -- --book-recipes-build`, introduced at `ed3ec31af9` with
authenticated command receipts corrected at `42cfea6a66`. Its native Book
helper publishes the Main introduction/default and Gutenberg chapters through
the existing command owners. G-2791/G-2778 should use this single producer and
the current [preparation prerequisites](../../testing/audit-corpus-prerequisites.md),
retaining source identities, rights assessments and the stopped-owner backup.
Private attempt receipts are not a ready consumer manifest; compatible target
admission remains with its existing owner.

## Source counterexamples and owner corrections

The preserved G-2805 source review is
`identity-reader-review.json`, reviewed at
`eeac26d5c755839d451351a29e9c753f41742d60`. The continuation began at
`f14fae6aa6ab96344a444f73ff0f104204540371`; its reader corrections are committed
as `c19435ff0c9659fe7a8d5027cc6d41787c9cfedd` after the first wave rebase
(previously `bb4ca4e176`).

| Finding | Reached owner regression and causal correction |
| --- | --- |
| IR-01 | A valid Account-only public header returned 400. Header, contents and chapter routes now use the existing public Work read for ordinary requests, retaining the Account disclosure viewer without selecting an Agent. Explicit preview continues through the represented read. |
| IR-02 | An independently published chapter disclosed contents of a Book with no Main text selection. Book contents/chapter admission now requires that current public selection in the requested language, or explicit preview authority. Catalogue metadata remains separately readable. |
| IR-03 | Withdrawn/replaced public-domain assessments and a rights transport failure still returned chapter bytes. Chapter bodies and derived headings now consume current Rights selection; SQL errors retain their cause through the public-domain and Work read owners. Original text does not depend on unrelated rights availability. |
| IR-04 | Body-only disclosure and native availability/digest changes after hydration still returned bytes. Exact body disclosure, current rights and the existing Content metadata batch are retained as closing dependencies and checked after later Work awaits. Derived headings share those fences. |
| IR-05 | Real Content corruption, missing storage, unavailable storage and wrong identity became an unavailable Recipe instruction; thrown transport errors lost the Work read classification. Selected instruction failures now remain recoverable Work read failures; denied/erased/disclosed-hidden and revoked authority remain opaque. |
| IR-06 | The seven invalid-bearer surfaces returned inconsistent status/code. Ordinary readers verify optional assertions; Main default also retains the Account disclosure viewer. The existing budget hook now uses `account_assertion_denied`. Budget accounting and native limits were not changed. |
| IR-07 | The local handoff incorrectly named the CAS field. The supported command above uses `expectedSelectionHead`; the existing independent helper already uses that field. Only its unsupported final Book Structure-publication command needs correction by its existing owner. |

Before production corrections, owner QA `20261019t062313-e7a338` reached the
Account-header and unpublished-Book counterexamples. Owner QA
`20261019t062606-bedc76` reached the rights, post-hydration disclosure/metadata,
Recipe failure and optional-bearer counterexamples. Harness ancestry/preview
setup failures in these development runs are separate from reached assertions.

After corrections, QA `20261019t063742-31d700` passed 139 of 140 owner tests;
the sole remaining failure was a missing `canReadWork` method in the new preview
regression's Access stub. QA `20261019t064259-0c4dff` then passed all 70 selected
contents/Recipe owner tests, including that corrected setup, Account-only
contents/chapter routes, rights failure/recovery, final disclosure/rights/native
fences, exact Recipe failures and a full page of twenty derived titles. That
page hydrates bodies in five batches, shares one native metadata probe and two
Rights probes, and reloads no body during the enclosing dependency close.
These are stack-free owner proofs, not the independent persona outcomes.

Final targeted QA `20261019t070558-0e4f04` at
`926090c1d6bbab594c39514abf8511cf31db683c` passed all 145 tests across the seven
selected identity, contents, session-fence, Recipe, optional-authentication and
rate-limit owner files. Recorded job `5229458d-f320-40f1-9892-52e403922707`
also passed types, inference, lint, AST and repository guards. Its documentation
step found this handoff missing from the documentation index; a separate
documentation correction adds that link.

The availability/digest transition regressions exercise the actual native read
owner at its storage boundary. They do not claim a public command can erase a
pinned revision, or that an immutable-row digest change is an admitted write.

## Minimum remaining live chain

At handoff preparation this worktree had no `.temp/identity-reader/corpus.json`
or `.temp/audit-corpus/recipe.json`; no compatible genuine corpus was staged.
The independent helper still contains the unsupported final Book command.
G-2791/G-2778 should apply the sequence above through their existing preparation
and sole retained corpus, preserve source/native identities and current rights,
and supply the successful public readiness receipts and compatible backup pin.
Do not rerun that known setup failure as a reader outcome.

Run the two independent proof files against the current compiling wave and an
isolated compatible restored copy, recording the product/specification pins,
genuine source digests, backup/restore identifiers, preparation costs and first
reached assertion per persona. The existing owner regressions are the focused
code proof selection; they do not replace the remaining ordinary public chain:
eligible/empty identity discovery and selection/replay/clear/next, public Book
header to exact occurrence/body and Main default, exact published Recipe
composition/instructions, rights and disclosure revocation, and all seven
optional-bearer surfaces. Preserve setup failure versus assertion evidence in
the final outcome record. The reviewed class remains open until that proof.
