# Realm publication caller lifetime

Publication controls belong to one mounted Realm visit and one observed generation of the existing session
QueryClient's `sessionQuery`. The caller captures its Realm, reader, locale, readiness and send/saved callbacks. It
retires when the session cache changes, the caller identity changes, or its mounted connection ends. A retired draft
clears its selected target, outcome, observed heads and uncertain intent; a later visit starts empty, even for the
same account.

The publication shelf may continue to supply newer authoritative heads while that caller remains valid. An explicit
uncertain retry keeps its original input, key and expected head. Conflict review remains a new explicit action with a
fresh key and the returned current head. Strict Mode's synchronous effect replay reconnects the same healthy visit,
while incrementing its connection ticket so callbacks and replies from the disconnected interval cannot run.

The session cache is only a caller-lifetime signal. Realm publication permission and subject readability remain the
native command's authority.

Decision: selected Subjects, in-flight commands and unavailable outcomes register with the shared departure owner; Stay retains the exact draft and retry, confirmed Leave retires only local continuations before destination reads without cancelling the native command, closing the panel preserves an uncertain retry, success or explicit clear releases protection, and untouched controls do not warn.
