# Controlled installation template

Copy `install.ts`, `install-archive.ts`, and the installation routes in
`routes/package-locks.ts` for another installation adapter. Keep the durable
generation, step, path inventory and journal in migration 053. Plan from a
verified replay, reject unsafe archives and path claims before effects, then
journal each fetch, verify, unpack, approved build and visible switch. Recovery
reuses the same generation and reconciles unknown non-idempotent hook outcomes.
Copy the crash, stale-head, denial, ownership and rollback assertions in
`package-install-api.test.ts`.

The npm template bounds one generation to the lock's 256 artifacts, at most 64
declared user-data paths, 10,000 archive entries per artifact and the archive
byte ceilings. Planning is O(A + B + P²) because local path collision checks
compare at most P bounded paths; application and recovery are O(A + B + P).
Indexed reads select only one installation, generation or lock; an installation
response returns at most 64 recent generations and marks a truncated list. The target root
is deployment-selected and must be private to the Main process; production
wiring and a sandboxed hook executor are separate deployment obligations.
