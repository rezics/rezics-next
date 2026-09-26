# Editorial protection and correction acceptance

These are prospective subcases of the existing acceptance inventory, not new
top-level IDs or executed results. The [contract](../contracts/editorial-protection.md)
owns meaning; [Jena](../storage/jena.md#editorial-protection-and-immutable-record-enforcement)
and [PostgreSQL](../storage/postgresql.md#editorial-protection-binding) own enforcement.
Existing partial head/source/release tests do not qualify these new combinations.
Review complete-case declarations when implementation adds these obligations;
do not carry an old passing label onto an untested protection profile.

## Required owner-boundary scenarios

| Scenario | Existing acceptance coverage | Required result |
| --- | --- | --- |
| Edit at `r17/p3` races protection at the same basis | MODEL18, SYS03, SYS10 | If protection wins, the edit cannot commit; if edit wins, the old-basis confirmation cannot silently confirm `r18`. Inspect both receipts and all projections. |
| Edit expects absent protection while another command creates it | MODEL23 | Absence is guarded. PostgreSQL operations serialize on the existing target row; an optional-row lookup is insufficient. |
| Omit a protection/control expectation or forge source versus human origin | MODEL17, IAM10, LIVE03 | Reject the unsupported/missing proof; trusted command admission determines origin. No client field upgrades authority. |
| Same-value human confirmation races source apply/reapply | LIVE03 | Human control advances despite equal bytes; later source work cannot overwrite it or restore source ownership. Retain the source observation/proposal. |
| Two supports share one upstream origin, then one is withdrawn | LIVE05, FACT01 | Separate support records do not manufacture independent corroboration. Withdrawal preserves remaining support and independent native confirmation. |
| Submit evidence or a new draft against review-required adoption | FACT03, WORK09 | Preserve eligible candidate data and pending review without replacing adoption or granting an official verdict. Protection remains unchanged. |
| Change a value or delete its protection/type/ownership link without advancing its head | MODEL15, MODEL16, MODEL24 | The actual footprint identifies the protected target and rejects the bypass inside the transaction, including projection and raw-ingress paths. |
| Add triples to an old revision, delete it, or retarget its manifest | MODEL25, MODEL26 | Ordinary writers cannot change the old exact state, even when the candidate passes SHACL. Same-key replay remains possible through its receipt. |
| Label an unrelated write as correction or use an approval for another candidate/context | GOV02, GOV23 | Exact proposal, effect digest, expected heads and admitted scope reject the substituted effect and extra mutations. |
| Proposer reviews through another Agent or shares the required control identity | GOV16, GOV23, IAM10 | Access independence proof rejects self-approval; private control links are not leaked into public history or errors. |
| Change proposal/evidence/rule/protection/content during review | GOV02, MODEL22, FACT04 | The decision cannot silently retarget. Preserve the original proposal and return conflict or explicit pending revalidation. |
| Concurrent approve/reject, two approvals, lost response and a new-key repeat | GOV03, SYS02, SYS11, SYS14 | One valid terminal decision/application per proposal revision; at most one adopted effect. Replays retain protection and return only currently disclosable results. |
| Ordinary editor attempts relax, source-control return or generic unseal | IAM10, GOV23, WORK05 | Separate authority and the existing rule are required; fixed meaning/release cannot be rewritten by a generic protection command. |
| Reviewer accepts a source-proposed correction, then a later source job runs | LIVE03, GOV23 | Reviewed application advances human control. Explicit source-control return retains protection and adopted value; later source apply still needs eligible open state and exact basis. |
| Reviewer loses authority while a decision is in flight | IAM07, SYS06, SYS11 | Preserve ordinary versus strong revocation guarantees. Unknown outcomes remain pending until original/cancellation receipts resolve. |
| Protect a following selection, or protect different Global/Realm selections | GOV03, MODEL20 | Pin the intended exact revision or reject the unsupported dependency profile; later upstream changes cannot alter protected adoption. Other contexts and independent drafts remain independent. |
| Resource-wide rule gains a child or spans multiple owners | MODEL16, MODEL23, SYS01 | A supported inherited profile guards membership and roots; otherwise reject it. Multi-owner work reports pending/per-owner outcomes rather than partial atomic success. |
| Erase a protected/sealed payload and replay old source or backup data | GOV07, SYS07, OPS10, OPS11 | Erasure reaches retained copies/projections under its frontier. Exact identity never substitutes new bytes, and replay cannot resurrect the payload. |
| Restore a cut from before protection/correction, or lose an application receipt | OPS03, OPS12, SYS13 | Hold routing until authoritative coverage reconciles protection/control, exact decisions, one-use applications, authority and erasure. A fresh epoch alone cannot reopen an apparently absent/open target. |
| Activate the profile over ambiguous existing source/control history | MODEL21, OPS04, LIVE03 | No migration-created verified status or automatic source takeover. Unsupported old writers fail closed; exact history and defaults retain their meanings. |

## Quality and work bounds

Run [FACT subcases](information-verification.md) together with the relevant
protected correction: reviewed-plus-disputed, stale policy/source reliability,
unknown dependence, non-independent AI copies, pending challenge and exact export.
A recomputed summary may change quality but never unlock or replace adoption.

For OPS05/OPS06, derive work for affected targets, evidence dependencies, candidate
bytes, revision history and reverse-impact fan-out. Use geometric unrelated data
sizes, one hot protected target and a widely reused source. Test 32/33 dependency
admission, continuation across 50/51 history entries and over-limit page requests
without treating a prefix as complete.
Measure engine reads/plans, adapter calls/bytes, writer occupancy, lock contention,
outbox amplification, queue lag and memory. Small multi-scale checks falsify
unbounded paths; they do not qualify the 500M deployment or a throughput target.

Exercise each admitted writer profile through its actual owner, plus direct
command-module negative cases; Main preflight mocks alone cannot establish
enforcement. Retain deterministic race barriers and replay traces, exact snapshots,
receipts and model/policy versions. Routine setup uses isolated compatible fixture
restores under the 600-second ceiling. Run affected root `yarn test` paths and
selected backend tiers during implementation; final runtime qualification remains
one clean `yarn qa --backend --record`. A documentation-only change uses
`yarn docs:check` and grants no runtime pass.
