# Board reading return

Decision: carry the admitted original Board URL as `boardReturn` through the existing thread route, reply navigation and sign-in; treat it only as navigation, with native readers and commands retaining authority.

Web prepares `BoardPreparedNavigation.href` from `boardSearch` and passes it through the existing
`BoardCommunity` and `BoardFeed` props. It includes the opaque cursor, sort, locale and admitted Subject
community return (including selected place and Realm). Each row adds its section and occurrence as a focus
locator. No page data, title, credential or permission is serialized.

`threadSearch` consumes `boardReturn` on both thread routes. Canonical redirects, linked replies, reader
continuation, composer sign-in and refresh forward the admitted value. `BoardContext` uses that origin only
when the disclosed Board matches. Direct thread entry retains its ordinary Board link. There is no ambient
last-visit lookup or history-state fallback, so route and session replacement cannot borrow another visit.

The sign-in local URL policy admits navigation. The Board schema then recognizes the mounted Board route
and reuses its search validator. A return reopens that exact native request; it never reconstructs a cursor
or searches previous pages. Invalid frontiers use the Board reader's existing restart state. A retired or
mismatched thread view explicitly offers restart of the original Board order and Subject context.

The supplied opening row arrays retain duplicate occurrence metadata beside the compatibility identity
map. Pin curation, reader leases, cache observation and command authorization remain in their existing owners.
