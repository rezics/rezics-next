# Personal consumption dates

Historical dates belong to a real native Library progress session. An owner can record a known year, year and month,
or complete calendar date for the start and finish of that occurrence. Missing month and day components remain
unknown. The service does not infer an instant, order partial dates, or substitute `startedAt`, `completedAt`, command
time or audit time for a user-reported date.

Dates use the session-addressed journal API, revision and clear semantics documented in
[Private progress-session journal](library-occurrence-reflections.md). The same occurrence can retain its private
reflection. Repeats remain separate by session ID. Historical dates do not imply progress, elapsed duration, current
Library entry state, completion, public activity, review or rating. Public log snapshots retain their explicit,
independent content and existing owner.

An installed import adapter may write a source date only when its precision fits the native calendar shape. It
retains unsupported evidence privately and does not invent month/day values.
