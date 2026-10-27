# Subject pages

A subject page is the hub for one subject: a work, edition, episode, character, person, organization, concept,
recipe or any other admitted type. This document is the single authority for what a subject page shows and how its
views are organised. Mechanisms live with their owners: covers in [Cover](../packages/ui/README.md#cover) and
[content covers](../services/kernel/src/content/README.md#covers), relations in
[semantic relations](../services/kernel/src/semantic/README.md#relations), ratings in
[ratings](../services/kernel/src/rating/README.md), templates in
[composition](../packages/composition/README.md#subject-views).

This page spans those modules because a reader experiences one page; splitting its rules across owners would let
each owner ship a correct part and the page still fail.

## Principles

- **Readers first.** A page shows covers, titles, people, scores, what people say and what to do next, in words
  readers already know. Contexts, revisions, identifiers and provenance sit at the end of the page or behind
  "Details".
- **Nothing raw.** No value is ever shown as an internal identifier, a media id, a document id or a property CURIE.
  A value the page cannot present is left out of the reading view and remains available in Details.
- **Every list is traversable.** A preview shows a few items, an exact or "at least" count, and a link to the full
  view. A full view pages with a continuation, never a fixed slice.
- **One type system, no per-vertical code.** Which views and sections a type shows comes from its presentation
  template and the data that exists, never from a branch on the type's name.
- **The page works without JavaScript.** Every view is a server-rendered URL; personal controls hydrate on top.
- **Honest states.** A section whose read failed says so in a sentence with a retry; it is not silently empty and it
  does not break the rest of the page. A contested fact shows as unresolved, with a link to the competing claims.

## Views

A subject page is a set of views, each with its own URL under the subject's address:

| View       | Path          | Shown when                                                                      |
| ---------- | ------------- | ------------------------------------------------------------------------------- |
| Overview   | `/`           | Always                                                                          |
| Editions   | `/editions`   | The type has editions or releases, and at least one exists                      |
| Contents   | `/contents`   | The type has ordered parts (volumes, episodes, chapters, routes) and one exists |
| Characters | `/characters` | At least one appearance exists                                                  |
| Credits    | `/credits`    | At least one credit exists (staff and cast)                                     |
| Relations  | `/relations`  | At least one relation exists in either direction                                |
| Reviews    | `/reviews`    | The type can be rated or reviewed (shown with an invitation when empty)         |
| Discussion | `/discussion` | Always for public subjects (shown with an invitation when empty)                |
| Lists      | `/lists`      | At least one public collection contains the subject                             |
| Details    | `/details`    | Always: every fact with qualifiers, sources, identifiers and history            |

A person or organization shows Works (their credits, grouped by role) instead of Credits, and Characters (roles
they voiced or played) when any exist. A character shows Appearances (works, with role and cast) and Relations.
A Realm-routed page adds nothing to this list; it changes the population of scores, reviews and discussion (see
[Realm context](#realm-context)).

Views appear in the order above. Each tab shows its count when the count is known. A view with no data is left out,
except Reviews and Discussion, whose empty state invites the first contribution. A list view whose items all fit in
its overview preview, with nothing to filter, has no tab: the overview section shows all of it without a "See all"
link, and the view's URL still renders. With typical catalogue data (a median work has about five characters, two
credits and one relation) most subjects show Overview, Reviews, Discussion, Lists and Details, and no tab repeats
the overview. A template may give a view the vertical's word (Contents is "Episodes" on an anime, "Volumes" on a
manga). The tab bar stays in view under the top bar while the page scrolls. On narrow screens it scrolls
horizontally with the active view in sight; it never wraps into several rows.

## Agents

People, organizations (studios, publishers, bands, groups) and automated agents are agents, whether they arrived
as catalogue subjects (an author imported from a source), as accounts, or both. Every agent has exactly one page.

- **One agent, one page.** An account is an agent. When an account is verified as a catalogue person or
  organization, the two are one agent with one page at the account's `/@handle`; the subject's address redirects
  there. An agent without an account keeps its subject address. The page is the same either way.
- **Views.** An agent's page is a subject page: Works (credits by role) and Characters come from the graph; an agent
  with an account adds its public posts, reviews and collections; an organization adds its members and, if it
  chooses, the accounts that speak for it. The view rules above apply unchanged.
- **Speaking for another agent.** A person's account acts for an organization through membership in that
  organization; what it publishes as the organization is the organization's speech and appears on the
  organization's page. A pen name or a collective name is its own agent, related to the people behind it; a link
  that is not already a sourced public fact is shown only when the people behind it make it public.
- **Who controls what.** The agent controls its self-presentation: display name, avatar, bio, links and which of its
  activity views are public. Sourced facts about the agent (dates, credits, affiliations) stay under the ordinary
  edit and review process with their sources; the agent can dispute them there but cannot remove them by owning
  the page. Its own statements about itself are accepted with the agent as their source.
- **Verification before merging.** An account becomes a catalogue agent only through verification. An unverified
  claim never merges pages or changes attribution.
- **Separate personas are separate accounts.** A person who wants a reading life apart from their author page uses
  another account under the same controller; ratings still count once per controller.
- **Never inside a Realm.** An agent's page is never routed inside a Realm or Zone. A Realm is a venue where the
  agent speaks, not where its identity lives.

## Overview

The overview answers "what is this, is it for me, and what do I do next" in the first viewport, then previews every
other view. Sections a type does not support are left out; the rest keep this order and stable anchors.

1. **Identity and next action.** Cover; title in the reader's language with the original title quietly beside it;
   type and date; principal creators, linked; the headline score with its population and count; the reader's own
   status, progress and rating with one primary action (Continue, Start, Add). On phones the cover is a thumbnail
   beside the title so this whole block fits the first viewport.
   The header's top right holds the reaction cluster (like, love, laugh, insightful and sad, each with its count; a
   subject has no upvote or downvote because its score is its rating) and an overflow menu that carries copy link
   and report. One reaction per reader; choosing another kind replaces it. Signed-out readers see the counts and a
   sign-in link.
2. **About.** The summary (spoiler-safe by default), a short set of key facts chosen by the type's template, genres
   and the most-used tags, and content warnings.
   When a subject has no summary, About shows its short description instead, and the header never shows one.
3. **Parts.** For types with parts: the next part for this reader, then the ordered list preview.
4. **Relations.** Related subjects grouped by relation group (order, derivation, world, membership), each with
   cover, title, relation label and date. Series order is shown as order, not as a list of links.
5. **Characters.** Main characters first, then supporting, each with portrait, name, role and cast.
6. **Credits.** Principal staff by role, in credit order.
7. **Ratings.** The score distribution, count and population, the reader's Realm scores, and a link to Reviews.
8. **Reviews and discussion.** The most helpful reviews and the most active threads.
9. **Lists.** Public collections and reading orders that include the subject.
10. **Sources.** Covers' credits, the sources of the facts shown, external identifiers, and a link to Details.

Every preview shows at most twelve items (fewer for reviews, threads and lists) and links to its full view when
there are more. A subject with only a
title still renders a complete page: the cover placeholder, the title, an empty-state invitation to add facts, and
Discussion.

## Covers on pages

The cover area always renders, at the frame ratio of the subject's type, on every surface that shows a subject,
with the designed placeholder when there is no image. The subject page shows its cover's credit as a caption at
`lg` size and in Sources. See [Cover](../packages/ui/README.md#cover).

## Relations, characters and credits on pages

Relations are shown from the reader's side of the fact: on a sequel the original appears under "Prequel", using the
property's inverse label. Symmetric relations appear on both sides under the same label. A relation group shows its
count, and the full Relations view pages through each group.

Characters, credits and relations come from the subject's facts on every page; they never depend on a wiki Zone,
a Realm or any other site having been set up for the subject.

Characters and credits are grouped by role and ordered by the stated credit order, then by name. A credited name
that differs from the subject's display name is shown with the credit. Spoiler-level qualifiers hide the
character, role or relation behind a reveal control according to the reader's spoiler setting.

Custom relation types from a selected Context appear in their own group under their own label, after the bundled
groups, and are labelled with the Context they come from.

## Scores on pages

A score is never shown without its population and count. The page headline uses the population of the page's
context: Global on the general site, the Realm on a Realm-routed page. Other populations appear as a labelled list
beside the distribution, each with its own figure; they are never averaged, blended or silently substituted for one
another. See [ratings](../services/kernel/src/rating/README.md#display).

## Realm context

The same subject page is reachable from the general site and from a Realm or Zone. The subject's facts are the facts
of the selected Context. On a Realm-routed page, scores, reviews, discussion and lists default to that Realm's
population and the page says so in one line; the reader can switch to Global or to another of their Realms. A
Realm-routed address for a subject the Realm has not published says so in one line and links to the general page;
it never presents general content as the Realm's, and never renders an empty page.

A Realm's population changes which figures and threads are shown first, not which facts exist: the facts are those
of the Realm's Context, which inherits Global except where the Realm accepts, replaces or suppresses a value.
