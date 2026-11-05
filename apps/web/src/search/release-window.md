# Released-edition group visit

Decision: released-edition group windows consume Search's single public window adapter with an explicit
`releaseSearchHref` constructor; the route's loader and observer share one query key and one current native read.
[Search's bounded address contract](README.md) owns retention, browser admission and focus. This visit keeps the
executed admitted form, never a result snapshot. Preparing cursors are unfinished reads: they do not gain positions
or enter browser history. A bounded in-memory preparation trail prevents forward cycles while deliberate Retry
can re-read the current preparation token. Failure retains only the lawful admitted return address.

Web's public reader/address and response origins fence dispatch and acceptance, including equal-principal
replacement. Query, locale and checkpoint replacement retire pending focus. The route observes the loader's read
without a second mount fetch; reader replacement and browser restoration explicitly refresh. Child windows keep
[their independent receiving law](README.md#release-child-windows); returning never restores an expansion.
Each activation owns its settlement by identity; a late completion for an earlier visit to the same cursor cannot
retire the current action, whose accepted render settles focus.
