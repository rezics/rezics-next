# Session media checks awaiting other owners' closures

goal: web
manager: web

This branch's caller, reservation-key and native attachment source is committed. Remaining check 6284aa99
(`6284aa99-a84a-4c94-8353-b12beb9dd722`) failures are owned by shared startup 2e0b5513, not by this source.

Check 6284aa99: 13 fail, 1 error. Generation/startup:

- `error: dev server did not start: $ bun scripts/storybook-dev.ts --app --host "127.0.0.1" --port "43631" --strictPort`
- `error: ENOENT reading ".../apps/web/src/paraglide/messages/access_account.js"`

Failing files/cases:

- `tests/media-reserve.test.ts`: a signed-in uploader reserves through the site and uploads to the address it returns
- `tests/media-reserve.test.ts`: an avatar reservation keeps the account container and avatar purpose through the site upload route
- `tests/media-reserve.test.ts`: reservations are read through the site by their uploader only
- `tests/media-reserve.test.ts`: the reserve route refuses malformed or oversized bodies before calling the kernel
- `tests/media-reserve.test.ts`: a future thread is reserved in place of a container, and any other target is refused
- `tests/media-reserve.test.ts`: a lost avatar reservation acknowledgement retries the original key and body through the site
- `tests/media-reserve.test.ts`: a Realm appearance reservation forwards the caller key so a repeated command finds the same reservation
- `tests/media-reserve.test.ts`: avatar upload advice uses the installed Content handle and preserves its native constraints
- `tests/community-presentation.test.ts`: actual Realm appearance management Page uses current route/native admission composition and reaches its real main-content without a resource404 or fake permission
- `tests/community-presentation.test.ts`: management host ownership read admits the configured native owner without bypassing current page continuity
- `tests/community-presentation.test.ts`: appearance action source failures offer an unavailable read retry while native denials remain hidden
- `tests/community-presentation.test.ts`: The default admitted community management journey resolves a same-site image or exact rules revision link through native selection and saves the exact reviewed reference while stale selections and uncertain original writes stay isolated
- `tests/thread-board-reading.test.ts`: unhandled error between tests (empty body after the access_account.js ENOENT)

Do not change those assertions here. Rerun after 2e0b5513 lands generated `access_account.js` and a dev that answers `/en`.
