# Classification, spoilers and measurements

Community fit evaluates an admitted Statement; it does not prove type membership
or change the statement's authored meaning. Spoiler voting is independent of
author/Realm content labels, inline concealment and NSFW display policy. A
changed criterion, disagreement about evidence and preference for an outcome
remain different acts under the [Context model](context.md).

The installed [judgment schema](../../services/main/src/modules/judgment/schema.ts)
gives fit and spoiler separate nullable dimensions and revisions. The
[aggregation policy](../../services/main/src/modules/judgment/policy.ts) owns the
Wilson calculation, uncertainty, protection and displayed status; owner tests
exercise sparse votes and independent population counts. Private accountability
prevents persona multiplication, while aggregate disclosure follows policy.

## Remaining contract

- Content spoiler/NSFW labels need revision and context-qualified author, Realm
  or platform correction bases. They govern selected body/media, not every
  version of a Work. Source labels stay source-qualified until adopted.
- Inline concealment needs explicit reveal and must never cast a spoiler vote.
  Definition-validity votes target exact definitions, not navigation or spoilers.
- Measurements need quantity kind, exact value/unit, method, coverage and time.
  Word count selects one language/body; duration selects a timed representation.
  Container aggregation avoids counting descendants twice. Unknown, zero and
  inapplicable must stay distinct; inference cannot invent a measurement.
- Grouped results must expose exact supporting statement/occurrence references
  before a user selects a judgment target and decision scope. Sharing a semantic
  Context does not merge Realm or personal voter populations.

These requirements have no complete owner API or qualification yet; retain them
until their schemas and behavioral tests carry them.

## Suitability and disclosure

Decision 1, product manager under maintainer delegation, 2026-09-29.
Keep recognizable `general`, `r15`, `r18` (sexual) and `r18g` (grotesque) labels,
with independent sexual and grotesque gates: material with both requires both
opt-ins. Missing assessment is `unassessed`, never `general`. Signed-out viewers
and people under 15 receive only general-eligible representations; `r15` starts
at 15, and separate adult opt-ins at 18, subject to
[market restrictions](../operations/trust-and-safety.md#safety-and-legal-readiness).

Imports retain source meaning: VNDB age 18 maps to `r18`, image sexual level 2
is not stored, image violence level 2 maps to `r18g`, and Bangumi `nsfw` maps to
`r18`. The separate [VNDB image dimensions](https://api.vndb.org/kana)
and [Bangumi schema](https://bangumi.github.io/api/) motivate source-qualified
mapping rather than treating absence as clearance. These are product mappings,
not proof that provider ratings establish legal eligibility.

External indexing and share previews use the anonymous representation; internal
search follows the viewer's eligibility. Adult material never enters email or
push. Originals, media, derivatives, history, caches and exports follow the same
policy; Realms can strengthen it, never weaken it. Classification cannot override
suitability. Neither sexual disclosure nor community agreement implies consent
to grotesque content; that is why the gates are independent.
