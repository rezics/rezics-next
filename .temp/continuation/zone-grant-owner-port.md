---
goal: accounts
manager: accounts
---

# Integrate the Access Zone grant port

The Access implementation exports `minimizeZoneGrantPage(tx, { admission, cursor, limit })` from
`services/kernel/src/access/zone-grant-cleanup.ts`. It accepts a typed, opaque owner admission, runs in the existing
`CommandTransaction`, selects K+1 raw keys from one grant table (K=1–100), processes at most K, and returns actual
candidate/processed/deleted counts plus the next cursor. The cursor binds the exact Zone route/id/home epoch,
resource/lifecycle revisions, generation, progress, protection revision and branch; terminal-account subject
selection also binds the erased account, original barrier version/T and captured primary-owner evidence. A changed
binding returns a zero-effect rebind. Exhaustion of the resource-grant and role-grant tables returns `complete` for
the existing owner CAS; Access creates no work row or acknowledgement.

`zone-disposition` removes all grants on that exact Zone. `terminal-account-subject` removes only the erased
account's identity subject rows with empty subject role on that exact Zone. The latter preserves editor grants,
organization-member grants, surviving owner grants and all grants on other resources.

The owner integration remains outstanding because the Semantic Zone branch issuer and durable work/CAS are not
landed in this checkout. Compose the exact delivered Semantic admission only after its parent lock, current
revision/protection check and branch evidence; call Access before child rows, then persist the returned grant cursor
with the same existing Zone work CAS through commit/rollback. The native terminal-account graph must pass the
original barrier version/T and captured primary-owner evidence with the exact Zone home and this separate cursor.
Keep the Accounts barrier and receiving custody held through the operation. Route the actual callable and
continuation through the native graph's complete eight scenarios, including held/replay/CAS/insertion schedules and
independent read-only checks of the exact persisted selected keys. Do not add a second coordinator, work registry,
receipt, absence certificate or synthetic acknowledgement.

The focused Access tests use migrated Zones and ordinary grant setup. Semantic's owner lifecycle acceptance and
the complete native terminal graph remain controller/owner integration work.
