# Bangumi Game first publication date

Decision: `bangumi@14` includes Game names, environment mappings and source genres, plus TVAnime websites; selected-family envelopes use `cross-media-entities@11+bangumi@14`.

Decision: accept only one unqualified strict ISO Gregorian `发行日期` value
(`YYYY`, `YYYY-MM` or `YYYY-MM-DD`); type-4 top-level `date`, qualified,
duplicate and unsupported occurrences remain unavailable. Selected-family
Bangumi envelopes use `cross-media-entities@11+bangumi@14` so an unchanged
selected row refreshes when either mapping changes.

The pinned Game mapping already admits `schema:datePublished` on
`schema:VideoGame` as the publication or first-release date with source
precision. `bangumi@14` reads only that Game-template field. It uses the current
Gregorian year/month/day parser, preserves the exact precision, and cites the
exact Bangumi subject URL. Qualified platform, market, edition and region dates
are withheld as a whole; no type-4 top-level fallback, release subject or work
identity inference is added. Type-3/6 date and TVAnime original-run behavior
remain on their existing paths.

Ordinary registration remains proposal-only. Explicit local showcase review
intent uses the existing finite publication manifest and journal to authorize
separate current acceptance and adoption commands. Selected-family records
retain the `bangumi_cross_media` alias, exact provider key and unversioned source
state when no provider revision exists. A corrected source refresh offers a new
candidate on the acknowledged UUID; sealed commands and independently adopted
facts remain unchanged. Missing or unsupported dates do not retract facts.
Reopen, exact unknown-send replay, source admission and facts fences continue
through the existing importer and publication journey.

- Touches: one source-identified Bangumi Game and at most one cited
  `schema:datePublished` candidate on its VideoGame.
- Bound: one shared Game-field scan visits at most 64 top-level fields, at most
  16 combined diagnostic entries, and the
  existing 65,536-character infobox plus 64 KiB projected source/command
  envelopes. The parser does not recursively evaluate wiki syntax or fetch a
  linked page.
- Growth check: `services/importer/tests/bangumi-game-publication.test.ts`
  covers ordinary and selected-family proposals, qualified omission and a
  corrected partial date. `services/kernel/test/imports/bangumi-game-publication.test.ts`
  covers the acknowledged UUID, independent acceptance/adoption, exact current
  value/citation and the facts fence. Native acceptance remains deferred to
  integration.
