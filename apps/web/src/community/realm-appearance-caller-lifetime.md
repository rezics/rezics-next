# Realm appearance caller lifetime

The appearance panel binds one read, save, selection and upload visit to its original Realm, QueryClient session
source and revision, signed-in account, CSRF credential, readiness, locale and adapter. A same-account cache update
retires the visit even when the visible session fields return to their prior values. The query key includes the
source generation and visit ID, so a new visit cannot read private data, drafts or uncertain intent from an older
cache entry.

The settings controller keeps the adapter it was created with. It checks caller and operation tickets before every
read, save, selection, upload or resume transport, before an upload's chained selection read, and after each await.
Retirement hides its draft and aborts the uploader signal. The uploader reads the existing browser session token for
each bounded reserve, byte upload and processing read; the session-cache subscription aborts that signal as soon as
the original session generation changes, preventing later transport legs from using a replacement credential.

Selection previews carry the opening visit, source ticket, exact slot and input and the current Realm head. Editing,
closing, reopening, changing the head or retiring the caller invalidates an older preview response. A current
uncertain save retains its original command, key and head for explicit retry. A conflict review remains an explicit
action that creates a new attempt from the current head. Ordinary rerenders preserve the active controller and
selection, while Strict Mode effect replay reconnects the same visit with a new connection ticket so old promises do
not become current again.

Native readers, permission checks, media reservation, upload completion, derivative summaries and server commands
remain the authorities for visibility and persisted appearance.

Decision: the caller mints one reservation key per selected file and retains it with the file. The site forwards that
key unchanged to the mounted Realm media route and mints one only when the caller supplies none. A retry of an
uncertain reservation repeats the same key and file, so the kernel returns the reservation it already created instead
of a second object. A retry with a known media id resumes that reservation; a new selection mints a new key.
Focused checks pin that forwarding at the media handler and the appearance retry; the storybook site walk stays with
the complete Auth06 and Community07 acceptance.
