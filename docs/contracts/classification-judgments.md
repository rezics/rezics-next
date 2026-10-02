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

- Content spoiler labels need revision and context-qualified author, Realm
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
with independent category preferences: material with both adult labels requires
both opt-ins. Missing assessment is `unassessed`, never `general`. The manager's
2026-10-01 review admits unassessed content on reads, indexing, share previews,
email and push; show **Not assessed** wherever the assessment is shown and never
count it as general. Signed-out viewers and people under 15 can see general
and unassessed representations; `r15` starts at 15, and adult categories at
18, subject to
[market restrictions](../operations/trust-and-safety.md#safety-and-legal-readiness).

Maintainer revision, 2026-10-01: General, R15, R18 and R18G each have an
independent saved preference. General defaults on and requires no age check.
Restricted categories request a missing birth date when enabled. Unknown age
cannot grant restricted eligibility. With an eligible birthday supplied through
another flow, the unspecified R15 preference defaults on; an explicit off
choice remains off. R18 and R18G default off and require separate opt-ins.
Eligibility includes both the person's category choice and the applicable age,
market, representation and Realm restrictions. A category opt-in cannot grant
Access authority. Unassessed content keeps its distinct state and the existing
channel admission above; disabling General does not relabel or silently exclude
unassessed material.

Account owns the complete private, self-declared birth date. Main
receives current age eligibility and content preferences, rather than deriving
age from public profile fields. An explicit birthday-publication choice is
independent of these gates. Main consumes live Account introspection for the
viewing state; public indexing and share previews retain anonymous eligibility.
Unknown age remains unable to render restricted categories.

Maintainer revision, 2026-10-02: ordinary interactive reads return the
Access-authorized payload and its assessments. The frontend applies the current
viewer's category choices, age and market state at each rendered body or image.
A rating is a presentation classification, not an Access denial. A restricted
image therefore does not suppress unrelated general text. Reads resolve only
the media referenced by the returned payload; they do not traverse a reference
tree or promote a descendant's rating into its container. Actual private-access
and platform governance restrictions remain server-enforced.

NSFW, author concealment and age assessment describe different things. An NSFW
warning says an image may be unsuitable for work or public viewing; it does not
establish an adult rating or prohibited content. The viewer's NSFW preference
defaults to masking and can allow immediate display. Author concealment can
mask any image, including general material, and continues to apply when that
preference allows NSFW images. Explicit reveal is local viewing state, not a
label edit or spoiler vote, and does not bypass category presentation settings.

Image inference is evidence tied to the exact file. Initially it is submitted
by the uploading client, with a producer boundary that permits later server
inference. Manual corrections take precedence over automatic evidence; failed
or unavailable inference remains unknown. Model output alone neither clears an
image nor creates a prohibited-content or review hold. Platform administrators
can correct and lock NSFW, age assessment and concealment independently through
the existing field-control mechanism; ordinary edits and automatic updates
respect the same protection.

Imports retain source meaning: VNDB age 18 maps to `r18`, image sexual level 2
is not stored, image violence level 2 maps to `r18g`, and Bangumi `nsfw` maps to
`r18`. The separate [VNDB image dimensions](https://api.vndb.org/kana)
and [Bangumi schema](https://bangumi.github.io/api/) motivate source-qualified
mapping rather than treating absence as clearance. These are product mappings,
not proof that provider ratings establish legal eligibility.

These explicit provider mappings remain separate from image NSFW classification;
an independent image NSFW flag does not imply `r18` or `r18g`.

Noninteractive indexing and share previews use the anonymous presentation;
email and push omit adult material. Those channels have no interactive viewing
state and retain their explicit default policy. Interactive originals, media,
derivatives, history, search and exports carry the applicable metadata for
consistent rendering; caches must not reuse one viewer's rendered choice for
another. Realms can strengthen presentation restrictions. Neither sexual
disclosure nor community agreement implies consent to grotesque content; that
is why the choices are independent.
