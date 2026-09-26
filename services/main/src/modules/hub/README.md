# Hub Content template

`admitted.ts` reuses Content's `draft.save` receipt and `content.draft` Access
admission for specialized Skill and Prompt models. Copy its current Work check,
exact Content intent digest, claim, terminal proof and retry behavior for another
Content-backed Hub subtype. `store.ts` owns the subtype rows and immutable file
references. `routes/hub.ts` owns private HTTP reads and writes, while
`projection-recipe.ts` registers literal text extraction for publication.

An import carries at most 128 files and 1 MiB of total bytes. The root
`SKILL.md` is at most 64 KiB. Paths are confined and case-folded before any
Content write. The importer preserves every byte, reports missing local links
and unverified compatibility/tool declarations, and never runs instructions or
scripts. A Content save can commit before the subtype transaction; replaying
the identical key repairs that boundary. Tests should copy the private read,
changed-key, stale-head, concurrent-key and post-Content repair assertions in
`tests/qa/integration/hub-api.test.ts`.

Cost contract: a Skill import is O(F log F + B) for F bounded files and B
bounded bytes, plus one Content revision and F indexed artifact references.
Exact read is O(F + B) and ignores unrelated imports. A Prompt revision is
O(P + E) for bounded schema properties P and examples E, plus one Content CAS
revision; the complete Prompt body is capped at 256 KiB. Exact Prompt read uses one revision lookup and one bounded Content
read. Publication projection extracts only one bounded text unit per revision.
