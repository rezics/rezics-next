# Main Version and Work continuity

Every admitted creative Work has one stable REZICS Main Version in its native
continuity scope. It gives readers a common entry and a maintained content axis,
including when the Work has no hosted body. The Work identifies the creative
referent; its Main Version selects the platform's current experience. An external
edition, an independently published translation and a fixed release have their
own identities. A new draft, display language or Realm does not fork the Work. A Main
Version unifies entry, not identity: a published version that rewrites a web
version is a second Work with its own Main Version
([Work levels](work-and-release.md#work-levels-realizations-and-versions)).

Native language contributions can coexist, including alternatives in the same
language. A reader's choice and a Realm recommendation select eligible variants;
neither transfers contributor control or changes the public default. A Realm's
substantive adoption and a shared semantic [Context](context.md) answer different
questions: which content it accepts, and how its members interpret statements.
Keeping those decisions separate lets communities disagree while sharing the
same Work entry.

Exact revisions and release manifests preserve what was selected when a reader
commented or an editor sealed a release. Current heads may move; historical
targets must not silently resolve to today's draft. The [Work operations](../../services/main/src/modules/work/)
and [native acceptance cases](../../scripts/qa/cases/native-work.ts) carry the
command and failure contracts. [Content publication](../../services/main/src/modules/content-publication/)
owns saved bodies and publication outcomes.

The first fixed native text release pins one selected published draft. Broader
multi-member and cross-owner release closure remains a separate dependency; an
exact release must never imply coverage that its manifest did not seal.

## Durable custody

Decision 10, product manager under maintainer delegation, 2026-09-29.
People must be able to recover what they authored and what they read. Existing
immutable revision and release owners above supply the basis; the remaining
custody work is stable block locators, historical dependency manifests,
recoverable local pending writes, explicit conversion losses, private draft media,
restore as a new revision and lossless export/re-import. Clearing chapter or text
draft content saves an exact empty revision; publishing it is refused.

Keeping identity and exact historical selection prevents comments and evidence
from moving when today's document changes. [W3C Annotation selectors and states](https://www.w3.org/TR/annotation-model/)
support precise targets, and [Peritext](https://www.inkandswitch.com/peritext/)
illustrates the difficulty of preserving rich-text intent. Neither establishes
REZICS's recovery or migration quality; owner tests must qualify those outcomes.
