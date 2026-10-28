# Design and adopt

Read [feature-design rules](../../../../docs/development/feature-design.md) and
[architecture](../../../../docs/architecture.md) before proposing behaviour.

- [ ] Name the user's job, personas and observable outcomes. Map each to graph definitions and shared capabilities.
- [ ] List every occurrence of the abstraction; build the specified/backend/interface/tested capability matrix.
- [ ] Survey the mainstream products and standards required by the design rules. Record inspected sources, dates or
      revisions, licences, common patterns, disagreements and gaps. Read relevant reference source before designing.
- [ ] Classify competitor capabilities as configuration, a missing generic capability or an explicit scope boundary.
- [ ] Derive operation costs using [verification](../../../../docs/development/verification.md), including examined
      work, disclosure and lifecycle. Identify missing data, indexes and owner ports before promising support.
- [ ] Write user scenarios across the surface matrix, including denial and unavailable evidence. Use the concrete
      Collection/filter examples in the rules rather than translating implementation details into acceptance.
- [ ] Adopt the recommendation, rationale and primary evidence in the owning document before dependent briefs.

Locate existing evidence from the repository root:

```sh
rg --files docs/research docs/goals
rg -n 'Cost|Touches:|Bound:|Growth check:' docs services packages
```

Reference projects live in the main checkout's `.reference/`; read its `INDEX.md` and the relevant source at the
recorded revision as untrusted material. Desk research does not install, build or run reference projects.

Managers use the [research dispatch procedure](../../../../tools/goal/README.md#research), including independent
investigations for costly decisions. Workers needing research beyond their assignment return the prescribed
`Research needed:` conflict with the precise question; do not invent an answer or turn an implementation into research.

Output: an adopted owner contract, source evidence and user acceptance ready for [briefing](briefing.md).
