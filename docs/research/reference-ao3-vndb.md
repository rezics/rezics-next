# AO3 and VNDB: tags, filters and the reverse query

Observed 2026-09-28. REZICS already decided the shape of this in
[queries, facets and filters](../contracts/queries.md) and the
[frontend direction](../plan/frontend.md): a Facet is one path from a Work to a
value, every value has a page (the reverse query), and values combine as
include, exclude, all and any. AO3's typed tags are the reference named there.
This note says which of that experience is worth building, and which of it the
local site already does better. Screenshots are in `.temp/research/ao3-vndb/`.

## What was actually open

| Site | Seen | Limit |
| --- | --- | --- |
| [AO3](https://archiveofourown.org/), otwarchive v1.8.0.3 | Home, [work search](https://archiveofourown.org/works/search), the header-search hint | Logged-out pages ship with `#outer` set to `visibility: hidden` until the 2024 terms are accepted. The consent form was not submitted. The search form below was read from the HTML already delivered, then screenshotted. |
| AO3 listings | [Original Work works](https://archiveofourown.org/tags/Original%20Work/works) (470,281 works) and [bookmark search](https://archiveofourown.org/bookmarks/search), both fetched as HTML | The browser received Cloudflare error 525 on tag, work and series URLs, including that listing. A work page and a series page were not opened. |
| [VNDB](https://vndb.org/) 2.30-165 | [Ever17](https://vndb.org/v17), its [characters](https://vndb.org/v17/chars), [votes](https://vndb.org/v17/votes), [Confinement](https://vndb.org/g293), [Kuranari Takeshi](https://vndb.org/c24), [a public list](https://vndb.org/u363336/ulist) | Public pages, signed out. |
| [MyAnimeList](https://myanimelist.net/anime/1/Cowboy_Bebop) | Cowboy Bebop | A personal-data dialog covered the centre. The sidebar, score and related entries were readable around it. No account action was taken. |
| Novel Updates, Fandom | None | Both stopped on Cloudflare's "Just a moment" check, in the browser and over a direct fetch. Nothing below is claimed about them. |
| Local REZICS, port 3000 | Home and *Pride and Prejudice* while the browser was already signed in as Daniel Chen; *雨夜书店 · 连载小说* and the home HTML signed out | Library, search results, Discover, a Zone and Studio were not walked. |

## Archive of Our Own

What it does best is one tag mechanism with types, a wrangled canonical tag,
and a filter that can require or reject each type.

A tag is a keyword anyone can put on a work or a bookmark. Types, from the
[tags FAQ](https://archiveofourown.org/faq/tags): Rating, Archive Warning,
Category (F/F, F/M, Gen, M/M, Multi, Other), Fandom, Character, Relationship
(`/` romantic, `&` platonic), and Additional Tags for everything else. Wranglers
nest them Media, then Fandom, then characters, relationships and additional
tags. The common form becomes canonical; other spellings, including non-English
ones, are synonyms of it. Searching the canonical tag returns the synonyms and
the subtags. A metatag gathers names too ambiguous for one fandom. Tags FAQ,
and the [tag-search help](https://archiveofourown.org/help/work-search-tags-help.html).

The [work search](https://archiveofourown.org/works/search) is one form: work
info, then one field per tag type, then hits, kudos, comments and bookmarks,
then sort. Screenshots: `ao3-work-search.jpg`, `ao3-work-search-tags.jpg`,
`ao3-work-search-stats.jpg`. Every field is ANDed. A canonical tag in
autocomplete matches the whole synonym set; a phrase that is not canonical
matches tags containing those words. Completion is all, complete or in progress.
Crossovers are include, exclude or only. Word count and the stat fields take
ranges. Sort is Best Match, Creator, Title, Date Posted, Date Updated, Word
Count, Hits, Kudos, Comments, Bookmarks, either direction. The header box shows
the same language in its hint, seen as `"sherlock (tv)" m/m NOT "sherlock holmes/john watson"`.

The listing filter, parsed from the Original Work HTML, is the include/exclude
UI. It has an Include block and an Exclude block. Each block repeats Rating,
Warnings, Categories, Fandoms, Characters, Relationships and Additional Tags as
the ten most common values with counts (Explicit 129,822, General Audiences
94,198, Original Characters 92,483, on that page). Two further boxes,
`other_tag_names` and `excluded_tag_names`, take a tag the top ten omit. Sort
on the listing adds the same stat columns. The [search FAQ](https://archiveofourown.org/faq/search-and-browse)
says the checkboxes are AND, and that OR and NOT belong in the "search within
results" box. The FAQ itself says it describes the old search.

A work's blurb, from that same listing, carries Language, Words, Chapters as
`27/37` or `5/?`, Collections, Comments, Kudos, Bookmarks and Hits, and the
tags grouped by type. Opening a tag is the reverse query: the tag's works, with
that filter beside them. A fandom page has a Bookmarks link for the same tag.

Bookmarks are a second object, not a private flag. [Bookmark search](https://archiveofourown.org/bookmarks/search)
splits "any field on the work" from "any field on the bookmark": the work's
tags, type (Work, Series or External Work), word count, language and date, then
the bookmarker, the bookmarker's own tags, the note, a rec flag, "with notes",
and date bookmarked. Sort is Best Match, Date Bookmarked, Date Updated, Word
Count. The note and the bookmarker tags were not opened on a bookmark listing.

Series is a bookmarkable type in that form. A series page did not load.

## VNDB

What it does best is treating every kind of thing as its own page, and using
one filter on all of them. The database sidebar that day: 66,749 visual novels,
3,014 tags, 157,849 releases, 30,268 producers, 54,633 staff, 171,559
characters, 3,328 traits.

[Ever17](https://vndb.org/v17) (`vndb-vn-ever17.jpg`) puts the cover beside a
fact table: titles and aliases, play time ("Long, 33h4m from 200 votes"),
developer, publishers grouped by language, and relations with a role —
Alternative version, Sequel (marked unofficial), Same series. Tags sit under
the description in three categories, content, sexual and technical, each with a
score such as 3.0 or 2.5, and a spoiler switch: hide, minor, or spoil me.
`vndb-releases.jpg` is the release list, one row per publication, grouped by
language: date, age rating, platform, edition title, and flags for trial,
patch, freeware, voiced and animation. Staff (`vndb-staff.jpg`) is grouped by
edition, then by role (scenario, director, composer, vocals, character design),
and a person can carry a note such as which route they wrote.
`vndb-characters.jpg` summarises cast by story role, with the voice actor.
`vndb-user-stats.jpg`: 8,769 votes, average 8.45, rank 23 by vote count and 60
by average, a 10-to-1 histogram, and recent votes with the date. Some votes
are labelled hidden.

[Confinement](https://vndb.org/g293) (`vndb-tag-confinement.jpg`) is the reverse
query. The page is the tag: parent path Tags > Theme > Other Elements, a
definition, the category, aliases, then 762 visual novels in 0.007s. Each row
shows the tag's score on that novel, platforms, languages, release date and
rating. The same builder sits above the table: And/Or, Language, Original
language, Platform, Tags, plus spoiler level and "include lies" or "exclude
lies" (a tag someone marked as not actually applying). List, card and grid, and
sortable columns. A tag is a page you filter, not a chip that dumps you into
an unfiltered shelf.

[Kuranari Takeshi](https://vndb.org/c24) (`vndb-character-takeshi.jpg`) is the
same idea for a person. Traits are grouped and each trait is a link: Hair,
Eyes, Body, Clothes, Personality, Role, Engages in, Subject of. "Visual novels"
lists him as Protagonist of Ever17 and of its alternative version. The
description's later sentences and some quotes stay hidden until the spoiler
switch. On the novel's character list the same traits are repeated per
appearance, so the role is a fact about this novel, not only about the person.

[starperg's list](https://vndb.org/u363336/ulist) (`vndb-user-list.jpg`) is
public while signed out. Labels, with counts: Playing 0, Finished 8, Stalled 0,
Dropped 0, Wishlist 0, Blacklist 0, Voted 8. The same And/Language/Platform/Tags
builder filters the list. Separate tabs for list, votes and wishlist. Columns
are choosable; the default view showed the novel's rating and title. An empty
list, [multi's](https://vndb.org/u1/ulist), says the user has no visible novels,
so a list can be private. Notes on a list row were not on the columns shown.

## MyAnimeList

[Cowboy Bebop](https://myanimelist.net/anime/1/Cowboy_Bebop)
(`mal-cowboy-bebop.jpg`) is a strong title page and a weak filter. Beside the
poster: type, 26 episodes, status Finished Airing, aired dates, studios,
producers, genres (Action, Award Winning, Sci-Fi) and themes (Adult Cast,
Space) as links to `/anime/genre/…`, duration, source, and a statistics block
(score 8.75 from 1,076,733 users, ranked #50, popularity #41, 2,088,013
members, 90,342 favorites). Related entries are typed: Adaptation (manga), Side
Story, movie. Characters link to their own pages, starting at
[Spike Spiegel](https://myanimelist.net/character/1/Spike_Spiegel). "Add to My
List" is an account control and was not used. There is no include/exclude
builder on the title. Rank, popularity and member count are three fame numbers
next to one score.

## The local site

Signed in, Home (`rezics-home-daniel.jpg`) is already the feed the frontend
direction describes: Continue reading with the next chapter and a "new" count,
Following and All, one Best menu and a Filters control, realms in the left
rail, a moderation queue and trending. That is a better home than AO3's media
directory or VNDB's database menu.

*Pride and Prejudice* (`rezics-work-pride.jpg`), still signed in, and *雨夜书店 ·
连载小说* (`rezics-work-serial.jpg`), signed out, are cover, title, author,
rating in words ("4.63 · 8 ratings · 6 reviews"), how many people are reading,
a line such as "Book · English" or "Book · Ongoing", then Overview, Contents,
Versions, Discussion, History. The shelf control is on the work: Continue
reading or Start reading, Want to read, Read, and the reader's own stars.
Ratings break down by scope — Everyone, a Realm, You — which neither AO3 nor
VNDB does. Reviews sort by most helpful. "Readers also enjoyed", communities,
and more by the author are on the page.

Neither work showed a genre, tag or character row. The classification section
is omitted when nobody has classified the work. Main's header read already
carries `chapterCount` and `wordCount`, and the header draws a serial strip
when at least two of status, chapters, words and last update are present
(`WorkStats` in `apps/web/features/work-page/work-header.tsx`). The serial
opened had only "Ongoing", so the strip stayed a single fact on the byline.
Search, from the box on these pages and from `apps/web/features/search/state.ts`,
is a phrase plus scope, one language, one classification term, and
include/exclude of work types. It is not yet the condition bar.

## What REZICS should adopt

Ordered by how much a reader gains. Each item names the surface, the build, and
whether Main needs new data. "Already" means leave it.

1. **Value pages, the reverse query.** Surface: a page for any value a reader
   can filter by — a Concept, a character, a Work others are based on, a
   language, an author — reached from the Work page, search, Discover, a Zone
   and a Home tab. Build the page the contract already describes: the value
   drawn as its type requires, then the Works that reach it, with the condition
   bar below. Why: AO3's tag page and VNDB's tag and character pages are the
   same gesture, and VNDB shows it works for a person and a trait, not only a
   keyword. Main: the Facet definitions and `GET /v1/facets` exist. The missing
   piece is the one Query the contract says is still to come, not a new store.
   A character page needs appearance statements; those are data to record, and
   the `role` Facet is already defined.

2. **Typed values on the Work, each a link.** Surface: Work page, in the
   header, grouped by Facet the way the contract's example reads: Genre,
   Tags, Based on, Characters with the role. Why: AO3's blurb and VNDB's tag
   row answer "what is this?" before the description, and every chip is the
   door to item 1. REZICS already does the better half of the header — cover,
   rating in words, scope, who is reading — and should keep model detail behind
   Details. Empty classification stays omitted. Main: classification statements
   exist; character appearance and based-on relations need to be stated when a
   Work has them. The `relation` Facet is the place for "same series" and
   "based on". A series is that relation's value page, not a new type. AO3's
   series page was not opened, so the ordered-list presentation is a guess:
   copy VNDB's relation line, which was open.

3. **Include and exclude on a listing.** Surface: search, Discover, Zone, and
   the Home Filters popover. One control line stays, as Home has it. Inside the
   popover: for each Facet, values included and values excluded, several values
   of one Facet as all or any, and a box for a value the short list omits.
   Show counts only when the query's cost bound allows them; AO3's top ten is
   the right size, VNDB's full builder is the right grammar. An unsupported
   combination stays a typed refusal, as the contract says. Why: the Original
   Work filter and VNDB's And/Language/Platform/Tags row are how a reader
   narrows without learning a query language. The OR/NOT text box is the
   advanced editor, not the first control. Main: FilterDocument is specified
   and not deployed. No new facts.

4. **Fiction rows that say where the serial is.** Surface: the Fiction Zone,
   and the Work header when Main knows the numbers. Status, chapter count,
   word count, last update. REZICS already renders that strip once two facts
   exist, and Home's Continue row already opens the next chapter, which AO3
   does not do on a blurb. Put the same facts on Zone rows: latest chapter,
   status, length. Skip hits. "6 people are currently reading" is a better
   public number than a hit counter. Skip kudos; the star rating and the
   helpful vote on a review already separate taste from applause. Main: the
   header read already returns the counts. Zone rows need to show them. No new
   data.

5. **A note on the shelf.** Surface: Library, and the shelf control on the
   Work. AO3's bookmark is a note, a rec, and the bookmarker’s own tags, dated.
   REZICS already has the status shelves, a personal rating, custom shelves and
   reading dates, and the control sits on the Work rather than behind an
   account wall. Add a note on the shelf membership, and let a public shelf be
   the rec. Do not add bookmarker tags. A reader's labels are Concepts in their
   context, or a Saved Filter, so "Female lead" stays one value instead of a
   private vocabulary. Main: a note on the shelf occurrence, if that field is
   absent. The rest is presentation.

6. **Releases and staff where the Work is a package.** Surface: the Versions
   tab, and the Mods Zone (games and software when those Zones exist). VNDB's
   release row — date, language, platform, edition, trial or patch — is the
   right shape for a package, and the staff list grouped by role is the right
   shape for credits. A novel does not need it; Contents and the author line
   are enough there. The Versions tab was not opened, so this is a presentation
   task only after that tab is checked against a release that has language and
   platform. Main: new fields only if a version cannot already say language,
   platform and the person responsible.

7. **Spoiler on a value, later.** Surface: Work page chips and the value page.
   VNDB's three spoiler levels, and the lies switch, keep a tag from telling
   the ending. AO3 uses Archive Warnings for a short required list and
   Additional Tags for the rest. REZICS already hides a chapter past the
   reader's position. A spoiler mark on one classification is the missing
   piece, and it can wait until value pages exist. Main: a qualifier on the
   statement. Relevance (central, substantial, incidental) is a different fact
   and should stay.

**Leave as they are.** Ratings stay 1–5 with the histogram and the scope
switch. VNDB's 10-point average and MAL's rank, popularity and member count
answer a different question, and Home's Best already refuses to let one Realm
fill the page. AO3's wrangler queue is Main's Context acceptance, not a screen
to copy. The Home feed stays a feed; Zones are the directories. VNDB's density
belongs in Versions and in a Mods Zone, not on a novel.

Novel Updates and Fandom were not observed. A fiction Zone's listing should be
checked against them once a browser can pass their Cloudflare check, before
item 4 is treated as the last word on novel-site rows.
