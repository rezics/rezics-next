# Private annotation and occurrence journal export

[Personal Library export](library-export.md) owns the canonical v1 format and its complete 22-section inventory.
This page describes the independent personal facts carried by that stream; it defines no alternate writer or
historical-format reader.

The `annotations` section carries each retained annotation revision, including explicit clears. It preserves
`accountId`, `subjectId`, nullable `entryIncarnationId` and `libraryProfilePin`, `annotationRevision`, `note`,
`priority` and `annotationUpdatedAt`. The Entry join is optional. A null note or priority remains null.

The `provenance` section carries each accepted native source observation. Its `observation` preserves `provider`,
`recordId`, `revision`, `privacy`, `sourceCreated`, `sourceUpdated` and `recordedAt`. Known timestamps retain their
source text, precision and zone. Absent, unknown, cleared, private and source-visible meanings remain distinct.
No upload credential, review capability or provider identity is reconstructed.

The `journals` section carries each non-retired occurrence with a positive journal revision. It preserves owner,
Session and Subject/version identities, state, original profile pin, progress revision and native progress times.
The nested journal has its own revision and `{startDate,finishDate,reflection,assessment}`. Assessment remains
`{meaningRevision:1,units:number|null}` on the private 0–20 scale; it is never a public vote. A missing or unknown
meaning is not an inferred null.

Reported dates contain only their supplied calendar components. Null is an explicit clear. Reflection `""`
remains empty text. These values never replace native started, completed or last-changed timestamps. The producer
does not invent a journal audit time or a provider-to-journal adoption link.

Canonical Episode completions and local completed units are separate per-Session fact sets. Export retains both
counters and each unit's native family, exact ID and original added time. Equal text across families does not
collapse evidence. These facts remain independent of journal dates, reflection and assessment.

Native source fences cover journal and annotation writes, accepted observation changes, both unit families,
reopening, retirement, Entry incarnation replacement and terminal account changes. A changed source makes the
original live capture stale; retries preserve its identity, expiry and opaque cursor operands.

Final manifests require exact row and UTF-8 byte totals for every declared section, including empty sections.
The current bounds and unsupported account families remain those of the authoritative export contract. Personal
recovery uses the existing [native personal-fact journey](library-archive-personal-fact-recovery.md); progress
recovery does not adopt journal or assessment facts.
