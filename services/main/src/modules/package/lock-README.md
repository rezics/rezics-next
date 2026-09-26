# Exact package lock template

Copy `lock.ts`, `lock-artifacts.ts`, and `routes/package-locks.ts` when adding an
ecosystem adapter. Keep the immutable resolution receipt as the selection owner;
the lock records its exact identity, scope, artifact locator and digest. Replays
read the lock, fetch only its locked locators, verify bytes and persist one
immutable result per artifact. The original resolution and lock are never
rewritten. Copy the private read, same-key replay, changed-key conflict and
unavailable-artifact assertions in `package-install-api.test.ts`.

Cost contract for the npm template: at most 16 resolution reads and 256 artifact
rows per lock. A replay issues one bounded fixed-origin fetch per artifact and
streams at most the profile's total artifact byte budget. Work is O(S + A + B)
for segments S, artifacts A and fetched bytes B; unrelated resolution history
and registry package names are never scanned. SQL uses the principal/key and
lock/ordinal indexes. This template currently admits npm registry receipts;
other ecosystems need their own exact artifact acquisition proof.
