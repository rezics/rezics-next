# Screen reading, preparation and return

`ScreenProfileOverview` is the ordinary Movie, TVSeries, TVSeason and Episode caller. It owns one current
profile/native episode window; `visit/owner.ts` owns bounded navigation and keyboard return. The native
`actions.ts` / `read.ts` operands are Subject, Type, locale, Context and opaque cursor. Display preferences
do not authorize or parameterize a native read.

Decision: keep the first actual spoiler preference outside native query and visit identity. An absent setting,
including the Subject caller's shared `defaultReader` sentinel, renders at level zero. The first actual setting
binds once, including an actual zero; repeated equal settings preserve pending reads, current facts, selected
evidence, the native cursor and Previous addresses. Apply the setting to facts and episode evidence immediately.
The current window keeps its definition identity while a continuation is pending, retaining only that scalar,
never the old page body. A newly observed definition replaces the visit.

Exact occurrence return uses holder/property/statement; episode return uses the original native membership.
When an exact target is hidden only because settings remain unresolved, keep its keyboard intent until preparation
or interaction. After preparation, only disclosed current evidence can receive exact focus; missing or hidden
evidence uses the existing region fallback and consumes the intent. Explicit disclosure does not revive consumed
focus. Pointer, keyboard and competing focus activity retain their cancellation rules.

Later preference replacement or loss advances a monotonic revision, including returning to an earlier value.
Subject, Type, release, Context, Realm, viewer, session/credential observation, locale, source observation and
browser-address replacement retain their existing retirement. Retired rows, callbacks and focus never revive.
Normal Back/Previous, explicit Retry and stale-window restart remain native reads of their original addresses.

The [navigation owner](navigation.ts) owns cursor, selection and one-hop episode return addresses;
[current visits](../screen-current-visit.ts) own correction/occurrence returns. The shared
[Subject address owner](../../pages/subject-visit-navigation.ts) validates return addresses, and the
[session owner](../../../session/README.md) owns browser observations and address leases.

Cost remains one replacing native episode page, `WORK_PARTS_PAGE_CAP`, a 1 MiB retained-page ceiling,
an 8192-character opaque cursor and at most eight Previous addresses. Preparation adds no read, hydration,
prefetch, body copy or page scan. Current and episode regressions cover pending/ready preparation, native call
counts, exact return admission, disclosure, Previous and later replacement; integrated execution is separate.
