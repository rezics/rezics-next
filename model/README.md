# Fixed first profiles

`definitions/text-publication-v1.ttl` validates an exact-focus contributor
eligibility decision that names one Contribution, Work, author and immutable
selected draft, with an original-contribution rights basis and public
disclosure. `tools/validate_text_publication.py` pins its SHA-256 and the
Jena SHACL 6.2.0/Java 21 runtime. The graph decision is distinct from a
context publication selection and creates no public MatchUnit.
[Executed publication shape evidence](tests/evidence/2026-09-24-text-publication-profile.json)
checks a valid decision and rejects missing draft, private disclosure and
missing type.

`definitions/text-contribution-v1.ttl` is the first draft Contribution shape.
It requires a distinct typed Contribution node, one Work reference, author,
language and draft head. `tools/validate_text_contribution.py` pins its SHA-256
and invokes the same Jena SHACL 6.2.0/Java 21 runtime. Main validates a trusted
candidate before graph activation; the draft body is held in an immutable
manifest and does not enter RDF text indexing. This profile has no publication
selection or public MatchUnit.
[Executed Contribution shape evidence](tests/evidence/2026-09-24-text-contribution-profile.json)
records one valid candidate and two missing-property rejections.

`definitions/work-metadata-v1.ttl` is the first admitted candidate shape for one
Work and its distinct maintained MainVersion. It requires typed references in
both records, a continuity profile and an explicit metadata-only hosting policy.
It does not mint the identities or create a body, contribution or release.
The shape bytes are pinned by SHA-256 in
[`validate_work_metadata.py`](tools/validate_work_metadata.py); changing the shape
requires review and a new profile revision rather than a silent in-place edit.

The helper selects both trusted focus nodes explicitly with `sh:targetNode`, so
removing an RDF type cannot avoid validation. It invokes the pinned Apache Jena
SHACL 6.2.0 command with Java 21, checks a complete validation report and applies
a 64 KiB candidate budget. This is a local validation consumer, not a native
write path. Main still has to enforce reciprocal linkage and slot uniqueness,
assemble the coherent candidate, guard its mutable read set, admit Account/Access
authority, and atomically activate revision anchors,
receipts and outbox through Fuseki.

After obtaining the checksum-verified Apache Jena 6.2.0 distribution and Java 21
runtime, run the focused cases from the repository root:

```sh
python3 model/tests/verify_work_metadata.py \
  --jena-home "$JENA_HOME" --java-home "$JAVA_HOME"
```

The valid fixture must conform. The missing-type and missing-MainVersion fixtures
must fail with paths in the Jena report. [Executed evidence](tests/evidence/2026-09-24-work-profile.json)
records the first run. See the [plan](../docs/plan/README.md#active-execution) for
current S1 qualification and remaining work.
