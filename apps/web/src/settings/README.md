# Settings

## Watches

`/settings#watches` is the existing private destination for a signed-in viewer. It reads one replaceable page for the
selected `thread` or `board` kind through the generated `accounts({accountId}).watches.get` operation, with the exact
opaque cursor and a limit of 20. Available rows link through existing localized thread or board routes. A withheld
row exposes only its personal subscription identity, kind and revision so its owner can still remove it.

Removal uses the generated watch ID delete operation with the original kind, expected revision and JSON-string
idempotency key. A confirmed removal applies only to that subscription episode; creating a later watch has a new
identity. An uncertain result retains the original command and blocks another removal until the person retries it.
Refresh may update the visible page but never claims the command succeeded. The existing dirty-departure recovery
guards a pending removal. Session, account or route retirement clears rows and callbacks before another visit can act.

Keep the existing thread watch toggle on the thread page. Settings does not add a second subscription inventory,
board toggle, watcher census or producer.

**Decision:** Settings removes the exact current thread or board subscription, including when its target is withheld;
opening, returning or starting a later subscription does not acknowledge or replay that removal.

**Cost:** Each selected-kind Settings page dispatches one inventory request and retains at most 20 rows. Removal is
one native command; deliberate refresh and explicit retry remain user actions. One controller owns one active read and
one unresolved original command, and retirement releases its rows and callbacks. Native SQL and history growth are
owned by Content. Browser growth coverage varies unrelated watches across 1, 10 and 100 sequential visits while
checking request counts, retained rows and bytes, active controller release and command attempts.
