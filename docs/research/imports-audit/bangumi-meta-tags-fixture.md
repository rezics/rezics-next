# Pinned Bangumi Book metadata-tag input evidence

Inspected on 2026-10-29 (Asia/Shanghai). The verified pinned archive contains an
actual native Book (`type: 1`, `id: 498`) with exact `后宫` in editor-maintained
`meta_tags`. The [fixture and full provenance](../../../specs/fixtures/imports/bangumi/PUBLIC-METADATA.md)
retain four native fields and the complete eight-member array. This closes the
archived-input observation gap identified in the fully read
[integrated research](../catalogue-filter-data-mappings.md), without revisiting
Concept meaning or filters. The chosen record is manga; it proves no light-novel
form, word count, conversion, proposal, adoption, filtering or readiness.

## Investigation and limits

Read the current [Bangumi inventory](../../../packages/definitions/sources/bangumi.yaml)
snapshot, subject-field and `meta_tags` decisions, and the complete
[conversion README](../../../packages/conversion/README.md). Reference reads:
the main checkout's read-only `.reference/INDEX.md`; reused
`.reference/shelves/bangumi-server` at `1997713eafc51487cbea705b37011442f35539fa`,
`LICENSE.txt`, `cmd/archive/main.go` subject export, `openapi/components/subject_v0.yaml`
metadata-tag shape, `internal/model/subject_type.go` and `internal/tag/domain.go`.
The [pinned Archive README](https://github.com/bangumi/Archive/blob/959474a4fcb833f6dabe8dd2f4fe192f82a71140/README.md)
and [copyright statement](https://bgm.tv/about/copyright) support the field and
licensing observations recorded beside the fixture.

Main-checkout `.temp` evidence located the original source-inventory attempt.
Its surviving `.temp/bangumi/archive.zip` was opened read-only and independently
matched to the exact pinned SHA256 before reading its member. A second local
candidate also matched. A redundant official pinned-asset download was stopped
when the verified local archive was found; its partial bytes were never evidence.
No newer archive, live subject sample, private API, account, Collection or user
post supplied the fixture. No dependencies were installed or upstream software run.

The first qualifying record in the inspected prefix is physical line 457.
The raw line was retained temporarily for consistency validation; only the
permitted projection is committed. Later records were not scanned, so no total
coverage, absence or frequency claim follows. Directory CRC32 is recorded as
member identity, not a claim that a full member CRC check ran.

## Future input-to-proposal acceptance sketch

After Semantic supplies an adopted property/profile and a real resolved binding,
let **H** symbolically denote that returned source-scoped Concept ID for the exact
key `(bangumi, meta_tags, 后宫)`. H is not a UUID assigned by this report or a
translated-label lookup. A future converter test should feed this observed
projection with the actual returned subject binding and H, and require the
reviewed classification proposal with native external ID `498`, citations and
honest missing-native-revision handling. Assert no light-novel or count inference.
Separately authored negative inputs must prove that missing/empty/withheld
`meta_tags`, an unresolved H, ordinary popularity `tags`, or infobox mentions
cannot substitute for this explicit public metadata assertion. These are future
tests, not assertions that the current converter emits or adopts this fact.

## Artifact consistency acceptance

The named acceptance is **native public Book metadata-tag evidence and fixture
provenance are recorded honestly**. The following offline test takes the retained
raw line (including LF) as its only argument, after the ZIP verification and member
location procedure in the provenance document. It validates artifacts only.

```python
import hashlib
import json
from pathlib import Path
import sys
import unittest


class Evidence(unittest.TestCase):
    def test_native_public_book_metadata_tag_evidence_and_fixture_provenance_are_recorded_honestly(self):
        root = Path("specs/fixtures/imports/bangumi")
        raw = Path(sys.argv[1]).read_bytes()
        self.assertEqual(len(raw), 2609)
        self.assertTrue(raw.endswith(b"\n"))
        digest = hashlib.sha256(raw).hexdigest()
        self.assertEqual(digest, "fb80ae3cb9b5a6713c4d8f105f0fcfa079963391c85f6aa15a00ebe9ddc5331e")
        row = json.loads(raw)
        fixture = json.loads((root / "public-book-meta-tags.json").read_text())
        self.assertEqual(set(fixture), {"id", "type", "name", "meta_tags"})
        self.assertEqual(fixture, {key: row[key] for key in fixture})
        self.assertIs(type(fixture["id"]), int)
        self.assertEqual(fixture["id"], 498)
        self.assertIs(type(fixture["type"]), int)
        self.assertEqual(fixture["type"], 1)
        self.assertIsInstance(fixture["meta_tags"], list)
        self.assertTrue(all(isinstance(tag, str) for tag in fixture["meta_tags"]))
        self.assertIn("后宫", fixture["meta_tags"])
        provenance = (root / "PUBLIC-METADATA.md").read_text()
        for required in (digest, "subject.jsonlines", "457", "1116919", "CC-BY-SA-3.0",
                         "https://bgm.tv/subject/498", "https://creativecommons.org/licenses/by-sa/3.0/"):
            self.assertIn(required, provenance)
        self.assertTrue(Path("docs/research/imports-audit/bangumi-meta-tags-fixture.md").stat().st_size)


unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(Evidence)).wasSuccessful() or sys.exit(1)
```

## Cost

### Offline archive evidence inspection

- Touches: two local ZIP candidates were hashed, 447451589 bytes each; only the
  source-inventory copy's `subject.jsonlines` prefix was traversed once, through
  457 records / 1119528 uncompressed bytes. ZIP decompression may read ahead.
- Bound: linear in the finite archive bytes for digest verification and in the
  inspected member prefix for discovery; at most one parsed row at a time and
  one 2609-byte retained raw row. The member's full size is 990267761 bytes.
- Growth check: no catalogue/history operation or production parser path was
  added. Source-size work is offline evidence collection, not a constant-cost
  catalogue claim. Retain one small fixture, not another source-data registry.

Validation is JSON/source-projection/hash consistency, scoped formatting and
`test -s docs/research/imports-audit/bangumi-meta-tags-fixture.md`. No kernel,
root, check-host or main-gate check is part of this evidence-only acceptance.
