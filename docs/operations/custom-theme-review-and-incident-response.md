# Executable theme review and incidents

## Review

1. Record the exact file manifest, transitive dependency digests, host Zone,
   declared origins, capabilities, expiry and submitter.
2. Have a different reviewer inspect the source, built bytes, data and origin
   access, accessibility and failure behavior. Test the declarative fallback.
3. Activate only the reviewed digest for its host. Changed bytes or capabilities
   require a new review. Keep the approval and diagnostic evidence private.

## Incident

1. Disable affected execution before asynchronous cache cleanup; use the
   global control if the affected set is uncertain.
2. Record the current activation and graph receipt, preserve bounded redacted
   diagnostics, and verify that a fresh public presentation serves the fallback.
3. Revoke the unsafe activation, invalidate cached effective presentations and
   check open sessions at their next visibility or refresh point.
4. Restore only a newly eligible reviewed revision. Do not revive an old
   approval through rollback.

The current backend has digest and expiry approval but no execution, review,
revoke or global kill operation. Do not deploy executable Zone packages until
those controls and a drill for stale caches, malicious dependencies and partial
recovery are verified.
