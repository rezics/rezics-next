# Classification, spoilers and measurements

## Independent meanings

Objective classification retains meaning, source/evidence and acceptance.
Community fit judges an admitted Statement; it is not a proof of type membership.
Semantic spoiler judgments, author/Realm content spoiler labels and inline
concealment marks are independent. Concealment always requires explicit reveal
and does not cast a vote. NSFW display classification is another separate policy.

## Judgment dimensions

Eligible statements admit nullable fit (-1 or +1) and spoiler (0 notSpoiler,
1 minorSpoiler, 2 majorSpoiler) dimensions. Updating one does not change the other.
No judgment is unknown, not an extra numerical category. Definition validity
votes judge exact term/relation definitions, not navigation paths or spoilers.
Curated subject associations can admit
spoiler judgments without voting their existence into or out of being.

Store one logical judgment per eligible voter/target/context with independently
revised dimensions. Private accountability prevents persona multiplication; public
attribution and aggregate disclosure follow policy. Immutable judgment revisions retain changes
without duplicating a full relational history family per dimension.

## Aggregation and protection

Keep the full three-level distribution, viewer judgment, sample size, uncertainty
and context. Protection and a displayed community conclusion are different outputs.
The initial policy uses a versioned Wilson confidence configuration: protection
tests the upper bound of major share, then any-spoiler share against 0.5; status
tests corresponding lower bounds, then not-spoiler share. No votes uses a declared
concept hint for protection and unknown status. A single-level small sample can
display its level with low-confidence/count disclosure; mixed unresolved samples
are disputed. The initial profile fixes `z = 1.96`; changing it creates a new
aggregation-policy generation rather than changing stored judgments.

For `n > 0`, use `p = successes / n`, `d = 1 + z*z/n`,
`center = (p + z*z/(2*n))/d` and
`radius = z*sqrt(p*(1-p)/n + z*z/(4*n*n))/d`.
Bounds are `center +/- radius`. Handle `n = 0` through the explicit hint/unknown
rule above. This uses a [Wilson proportion interval](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)
as a versioned protection heuristic, not a probability that a subjective judgment
is objectively true.

Viewer choices are show all, hide major and hide any, defaulting to hide any.
A statement's protection covers its derived matches. Confident direct evidence
on the effective concept may override derived protection under the declared rule;
otherwise combine conservatively. Context fallback never combines populations.

## Content labels and measurements

Content labels are revision/context-qualified declarations with author, Realm or
platform correction basis. They govern the selected body/media, not all versions
of a Work. Source spoiler/NSFW metadata remains source-qualified until adopted.

Measurements record quantity kind, exact value/unit, method, coverage and time.
Word count uses one language/selection; duration uses a timed representation;
aggregation avoids double-counting container and descendants. Unknown, zero and
inapplicable remain queryable distinctions. Inference/retrieval expansion does
not invent measured values.

## Implementation and qualification

Maintain bounded context/target aggregates from authoritative observations and
generation-bound rebuilds. Changes invalidate matching badges/search/snippets.
Test dimension-independent edits, sparse votes, disagreement, source imports,
local rejection/global fallback, multi-source effective facts and private counts.
Display grouping never merges judgment target identities or voter populations.
A grouped result retains its exact supporting statement/occurrence references;
voting from that result requires an explicit admitted target and context.
