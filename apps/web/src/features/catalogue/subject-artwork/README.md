# Subject artwork caller lifetime

This module owns the lifetime of one explicitly selected non-cover Subject artwork inspection in the ordinary
fact view. `pages/data.tsx` supplies the original statement, media UUID, Subject title, property label, locale,
source object and route address. The header cover remains separate.

Decision: adopt first Reader preference and authority preparation without replacing an admitted selected fact;
retire later replacements and any inspection whose current native disclosure conceals it.

An omitted Reader is unresolved preparation, rendered using `subject/reader.ts` safe defaults. An explicitly
supplied Reader with those same values is an actual observation. The boundary adopts only the first observation
of previously unresolved preferences. Later equal observations retain the current inspection; changed preferences,
including a return to unresolved preferences, retire it. Returning to earlier values never restores old state.
The fact follows current suitability while preserving explicit Reveal and Hide choices during preparation.

The artwork disclosure uses the existing `ReadingDisclosureScope` and `useIncarnationState` authority. Its mounted
position stays stable when first preparation leaves the fact disclosed, including when the fact becomes below
the spoiler threshold. If the current disclosure closes, the selected presentation and pending request are retired;
reopening requires explicit inspection. A changed threshold that still conceals the fact resets its explicit spoiler
disclosure. Other fact kinds keep their own disclosure contracts.

The first unretired null-to-admitted `ArtworkReaderContext` incarnation is preparation. A later authority
replacement permanently retires that source's admission. A new source object starts a new admission and retires
the previous selection, even with equal metadata. Subject, Context, release, route address, reader partition,
locale and view replacements also retire selection. Account, session and browser exposure still use the authority
and current checks in [session.tsx](session.tsx); this caller adds no observer or fallback authority.

Generation and request identity make retirement permanent across A → B → A, concealment and unmount. Delayed
callbacks retain their original current-authority check and cannot restore an old selection. Preparation never
changes the exact media read operands, selected statement, supplied text or native credit/licence presentation.

[read.ts](read.ts) owns the bounded native read and response validation. [session.tsx](session.tsx) and
[actions.ts](actions.ts) own native session and authorization admission. The existing
[NativeDocumentImage](../../../threads/document-media-image.tsx) owns image display, credit and inspector behavior.
These contracts remain with those sources.

Cost: one selected inspection, O(1) caller lifetime state and one existing native read per explicit inspection or
retry. No preparation read, prefetch, row hydration, image collection, source write or authority observer is added.
The [mounted regression](../../../../tests/subject-artwork-mounted.test.tsx) covers first pending and ready
preparation, actual default-valued preferences, exact media and credit, concealment, equal observations and later
preference, authority, source and address retirement with delayed results.
