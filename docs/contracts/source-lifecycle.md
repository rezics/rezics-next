# Source observations, support and native adoption

## Basis for acquisition and reuse

Preserve source evidence for inspection and correction. U.S. company status and a
collaborative wiki do not settle copyright, commercial use or provider terms.
Assess facts, expression, images and compilation structure separately; see the
[rights review](../research/source-data-rights.md).

Favor intake with exact provenance and scoped responses to restrictions or complaints.
Company status, NC markers and missing license information alone do not reject a
provider; unknown rights remain unknown. Preserve attribution and sharing duties.
Assess acquisition, retention, display, search and redistribution separately.
ShareAlike alone does not ban commercial use; NC depends on the use. Intake is an
operational decision, not legal clearance.

Keep API and retention terms separate from data rights. Record omissions and limits;
reproduction or native editing cannot expand retention rights. Complaint decisions
must fence refresh at their scope while preserving independently supported facts.
See [content governance](content-governance.md#rights-complaints) and [erasure](../operations/erasure.md).

## Why observation, support and control differ

An observation records exact captured bytes, coverage and time. Mapping classifies
source fields without accepting native facts. Support joins evidence to a native
slot; withdrawal leaves other support and native acceptance intact. Same-value human
confirmation takes control but proves neither accuracy, reuse rights nor review.
A missing field in partial coverage is not a deletion signal.

The [typed source cases](../../scripts/qa/cases/source-conformance.ts) cover intake,
conversion, correspondence, adoption, withdrawal and recovery. The
[field schema](../../services/main/src/modules/source/field-schema.ts) records support
and control bases; [native control](../../services/main/src/modules/source/field-control-native.ts)
guards heads, and [attachment](../../services/main/src/modules/source/support-attach.ts)
verifies evidence against an exact native revision. Only admitted slots can be promoted.

## Editorial protection and quality integration

The [general protection contract](editorial-protection.md) still needs integration
for all source-controlled fields. Review-required values need review before refresh.
Source changes must invalidate dependent [quality assessments](information-verification.md#summary-policy-and-freshness)
without treating mirrors as independent or changed evidence as disproof. Recovery
needs retained evidence and fences; selected tests do not qualify every mixed-owner cut.

## Child correspondence and structure

### Bounded native author-credit adoption

Work credits use qualified relations to external author references; source
occurrence, role, order and support stay distinct from native identity. The choice
follows [Schema.org Role](https://schema.org/Role) and [PROV-O](https://www.w3.org/TR/prov-o/#qualified-terms-section),
which do not prove authority or recovery. Agent resolution, split/merge, other
child families and general protection remain future work.

## Change intake and reconciliation

Bootstrap and change feeds overlap at a recorded frontier. Gaps need reconciliation
or a new baseline; an empty query does not prove deletion. Runs retain provider
contracts and examples without freezing future versions. Keep source coverage,
mapping, query and export qualification separate; see [source acceptance](../testing/source-conformance.md) and [workers](../services/workers.md).

## Import rollout

Decision 26, maintainer, 2026-09-29. Imports write only through Main commands;
qualification uses functional tests, not large import campaigns. Start with
downloadable dumps from VNDB, Open Library, Wikidata, Bangumi, MusicBrainz core
and the old site. The later [vertical-engine seeds](../product/platform-thesis.md#one-graph-many-language-fronts)
add Arena and ISFDB within the same dump boundary. Principal-class rate limits
and backpressure preserve shared capacity. Availability remains a dated observation.

A bounded, rights-cleared launch catalogue with named stewards is a separate
deliverable. The reason is reproducible intake without bypassing native authority,
review and recovery. [Wikidata dumps](https://www.wikidata.org/wiki/Wikidata:Database_download)
and [Open Library dumps](https://openlibrary.org/developers/dumps) provide bulk
acquisition precedents; an API response saved as JSON does not silently expand
the source scope. The broader reuse policy above still distinguishes intake
from publication rights.

## Reader upload retention

Personal library uploads stay private to the reader's own Person. Raw source
fields, match decisions and replay plans expire seven days after upload, even
when applying the file is unfinished. Main excludes expired uploads from reads
and exports immediately; its retention worker deletes them in bounded batches
on a one-minute poll. Re-uploading an identical file does not extend its expiry.

Before expiry, the reader's Main library export includes all retained source
fields alongside the applied Library records, so unsupported fields can be kept
by saving it; Account's credential/profile export does not contain Main-owned
Library data. Deleting an upload sooner leaves applied sessions, shelves,
ratings and reviews in their ordinary stores; only source identity hashes and
session IDs remain, to prevent invented rereads. Account deletion removes
uploaded source evidence and import receipts for its own Persons, including
replay plans containing private review text. This is logical deletion; prior
PostgreSQL row versions, WAL and backups follow the
[erasure and recovery procedure](../operations/erasure.md#backups-and-completion).
