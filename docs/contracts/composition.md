# Content composition

A Structure represents uses of resources, not ownership of their content. Each
occurrence has its own identity so repeated targets, reorder, progress and source
correspondence remain distinct. Membership, navigation, consumption order and
semantic part-of have different meanings; a container reference does not expand
its descendants. The shared Structure format, owner profiles and commands carry
these rules in `services/main/src/modules/structure/`.

The authoring choice is contextual: an ordinary chapter may follow eligible
published content, while reviewed adoption and a fixed release select exact
revisions. A sealed manifest captures selected dependencies rather than a global
database snapshot. [Structure history](structure-history.md) explains the
revision choice; `scripts/qa/cases/content-composition.ts` names the acceptance
scenarios.

## Remaining design work

Source withdrawal must remove only the source's support, preserving independent
adoption and contribution ownership. Structure metrics still need explicit
coverage rules (direct children versus selected leaves), provenance and a
pending state; aggregating both a container and its descendants or alternative
languages would double-count. These rules need owner operations and tests before
this page can be retired.
