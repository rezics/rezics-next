# Public profile page binding

Decision: Account and Agent list assembly consumes the page-owned `AccountProfilePort`, installed explicitly by
`PublicProfilePage` through `AccountPageApplication` and the Accounts-owned `accountProfilePageBinding`.
No global setter or load-time registration selects the adapter. The ordinary Subject composition has no named
profile route or private action cohort; public profile routes and their stories install the live binding.

The page application owns selection of the resolved profile, the planned collection response, contribution view,
current cursor, raw publication object and admitted row cohort. It renders previews, replacing windows, empty and
failed sections, and selects continuation controls through the port. The port carries plain typed requests and React
capabilities; it imports no Accounts implementation. `page-model.ts` owns the shared page response and planning
context without loading the Subject renderer. Optional catalogue Terms advice remains a Subject renderer extension.
Shared section components live in `overview-section.tsx`, so Account assembly need not evaluate the Overview graph.

Accounts binds the existing collection visit, contribution route controls and contribution action host. The page
application declares watch, reaction, reply, report and session-lifetime capabilities on `AccountProfilePort`.
Threads and Report supply the existing engines through public adapters; the ordinary public-profile route and
stories bind those adapters with `bindAccountProfilePage`. The host uses the session facade for observation and
leases, without a second provider, store, per-row read or Router requirement. Isolated mounts keep QueryClient and
browser address. The concrete binding preserves the exact page, read, source, action selection, publication and row
identities used by reader retirement and receipts. The root still mounts the existing route, action cohort and
reader-response scopes around the Subject page. Their disclosure, verification, observation, continuation and
work-budget rules are unchanged.

The named collection route mounts `AccountCollectionWindowsScope` above cursor-keyed pages and calls
`useAccountCollectionWindows`. The page application plans the response and supplies only an admitted profile/window
projection to the Accounts host. No page means a temporarily absent response; an explicit null means no matching
public profile and retires the visit. Equivalent public profile projections preserve the same publication identity;
changed profiles, denial and exposure loss retire it. No predecessor response bodies are retained.

The public entries are the consumer port and application, pure page model, and concrete Accounts page binding.
The owning module dependencies and architecture baseline do not grow. Other account operations keep their owners.
[Collection windows](collection-windows/README.md) owns the eight-coordinate predecessor bound and native reread
semantics. Contribution windows keep their eight-coordinate predecessor bound, exact URL custody, deliberate retry
and keyboard focus handoff. A bare continuation still selects exactly one distinct planned native list and forwards
its opaque cursor, planned limit and native outcome unchanged.

Focused application tests cover publication matching, equivalent versus missing profile projections, empty final
windows, native failure states and exact contribution receipt inputs. Existing public-contribution-actions host,
adapter and lifetime tests remain the fewest that pin capability composition; stories keep named states only.
Existing continuation and installed host tests retain their assertions. Native, browser and root acceptance run in
the integration verifier.
