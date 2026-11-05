# New thread caller lifetime

A new-thread page owns one caller for its original board, purpose, loader key, validated preset subject and locale. The caller
also captures the existing session `QueryClient`, its observed session-cache revision, signed-in account and CSRF
token. It retires permanently when any of those inputs changes, when readiness is lost, or when its mounted
connection ends. Successful replacement of the existing session cache advances the revision even when the
replacement has the same account and token; observed away/back transitions cannot restore the old caller.

The lifetime observes only the existing `['session']` cache. It adds no session request, credential fallback or
retry. The review vote read checks the selected subject, current visit and connection before invocation and after
completion. A stale result cannot publish a private preview or citation. Discussion selections keep their existing
ordered zero-to-128 reference contract and are admitted only while the route visit is current and unlocked.
An unavailable current-vote read shows localized recovery and retries only on request; an explicit no-vote result is
shown separately, and a refreshed vote still requires an explicit citation choice.

The departure owner decides before navigation to a different pathname or preset subject can commit. Stay preserves
the caller and any immutable uncertain intent; Leave unmounts the old editor and creates a fresh usable visit for the
selected board/subject with a fresh key even when loader data is reused. Confirming Leave retires the original caller
before awaiting replacement route reads. Display-title changes and refreshed loader
keys alone preserve the original visit and key.
Other caller retirement leaves the composer mounted until its own account/session privacy rules clear it. Route
submit and success callbacks use the original caller; an obsolete success cannot write the draft cookie or navigate.

`tests/thread-creation-lifetime.test.tsx` covers the real route composition, private vote read, both metadata fields,
and `PostComposer` against the existing session cache and deferred server-function seams. Those composed assertions
are authored but **UNRUN** pending controller verification; scoped web typing does not establish their completion.
