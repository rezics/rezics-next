# Mixed discovery results

`DiscoveryResults` is shared by the generic Search page and these Patterns stories. The page sends one opt-in
`representation: discovery-v1` request to the existing Subject search endpoint. A legacy response is unavailable,
not a successful empty mixed result. Typed Subject search and bounded suggestions retain their current protocols.

The fixtures describe the adopted Account/Search handoff; they are not native recordings or readiness evidence.
The generated client at this base still describes the legacy Subject wire. The consumer validates the opt-in
response and never substitutes attribution, detail lookups, index registration or Subject counts for native data.

Review these exact IDs at 390 and 1280, with locale and light/dark toolbar globals:

- `patterns-discovery-mixed-results--mixed`
- `patterns-discovery-mixed-results--handleless-account`
- `patterns-discovery-mixed-results--public-subject`
- `patterns-discovery-mixed-results--empty`
- `patterns-discovery-mixed-results--unavailable`
- `patterns-discovery-mixed-results--not-ready`
- `patterns-discovery-mixed-results--loading`
- `patterns-discovery-mixed-results--current-link-refusal`

Root screenshot review is pending. Pages/Discovery/Search adds Mixed cards, Mixed unavailable and Mixed preparing
through the actual page loader and existing fake transport. Pattern plays exercise keyboard links; page plays
submit the real header query and observe its unavailable response. No viewport, locale or theme variant exports.
