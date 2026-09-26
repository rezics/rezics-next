# Exact package lock template

Copy `lock.ts`, `lock-artifacts.ts`, and `routes/package-locks.ts` when adding an
ecosystem adapter. Keep the immutable resolution receipt as the selection owner;
the lock records its exact identity, scope, artifact locator and digest. Replays
read the lock, fetch only its locked locators, verify bytes and persist one
immutable result per artifact. The original resolution and lock are never
rewritten. Copy the private read, same-key replay, changed-key conflict and
unavailable-artifact assertions in `package-install-api.test.ts`.

The npm adapter uses registry SRI. The Cargo adapter reads each selected crate's
SHA-256 from its retained crates.io index snapshot. The Go adapter checks every
selected release against its retained proxy capture and a verified checksum
database receipt, then locks the signed module ZIP `h1:` value. `lock-go-zip.ts`
computes Go's deterministic file-content hash on replay. All three adapters
keep their native coordinate and selection receipt in separate segments; the
current installer admits only npm archives.

Cost contract: at most 16 segments and 256 total artifacts per lock. Cargo
snapshot parsing visits at most 32 index files of 64 KiB each once per segment.
Go validation reads at most 128 captured releases and checksum receipts per
segment. Replay makes one bounded fixed-origin request per artifact and
streams at most 256 MiB in total; Go ZIP inspection admits at most 2048 files
and 32 MiB expanded content per artifact. Work is O(S + C + A + B + U), with
segments S, retained index/capture input C, artifacts A, fetched bytes B and
Go ZIP content U. SQL uses principal/key, capture and lock/ordinal indexes;
unrelated resolution history and registry package names are never scanned.
