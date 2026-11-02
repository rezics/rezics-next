# Identity rating currentness

The vote command resolves a readable target before opening its command transaction, then rechecks that resolved target with one indexed redirect lookup in the voter's transaction. A redirect, non-visible terminal, or pending/unavailable identity home keeps the command attempt retryable and writes neither the vote nor its event.

Visibility repair uses `IdentityRatingParent` as the native Performance boundary. The parent persists the immutable page binding and commit receipt with each effect, verifies the owner incarnation before commit and acknowledgement, and replays those records after an interrupted return. The consumer processes at most 64 work items per page and at most 8 pages per invocation; terminal provenance is reclaimed only after the parent's final-reference check succeeds.
