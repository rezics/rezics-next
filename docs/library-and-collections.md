# Library and Collections

A person's library and their lists are one capability. Every vertical (books, anime, games, visual novels, recipes,
records) configures it through definitions; no vertical has kernel code of its own. The evidence and the feature map
of comparable products are in [the library abstraction research](research/library-abstraction.md).

## Model

- **Personal facts.** For one account and one subject: at most one exclusive entry state, any number of labels,
  progress sessions and copies (holdings). They are private unless a Collection or a published log discloses them.
  Ratings stay with ratings.
- **Library profiles.** The subject type declares, in the definitions release and inherited through its bases, its
  entry state set, allowed progress modes and units, copy kinds and statuses, and import sources, as it declares its
  cover ratio. Kernel code holds the generic algorithms (exclusive state, the three progress modes, holdings), never
  a vertical's vocabulary. Stored values are bound to the profile revision that accepted them.
- **Collection.** The one list: identity, curator, visibility, title and description; followable, mountable in a
  Zone and exportable as a schema.org ItemList. Its membership is either
  - **curated:** ordered member occurrences with notes, chosen by the curator; or
  - **dynamic:** a saved query over the curator's personal facts and the catalogue's indexed properties, evaluated
    when the Collection is read.
- **The library is the account's dynamic Collections.** Each account has built-in dynamic Collections: everything
  in the library, and one per state of each state set in use. Users save more (finished this year, owned on a store
  but not started, want to cook and vegetarian). The shelf's status tabs are these Collections.

## Consequences

- **One list surface.** Members page, sorts, filters, layouts (grid, list, table), bulk actions, export, follow and
  Zone mounting work the same for curated and dynamic Collections. The shelf page is the Collection page of a
  dynamic Collection.
- **Disclosure.** A dynamic Collection is private until its curator makes it public. A public one discloses the
  subjects its query returns and nothing more of the facts behind them. Public listing counts include it only while
  it is public.
- **Cost.** A dynamic query uses only indexed predicates on the curator's partition and indexed catalogue
  properties. A page examines a capped candidate budget and returns at most the page size with a keyset cursor;
  a query with an unsupported predicate is rejected when saved, never run as a scan.
- **Shared mechanisms.** Bulk operations, list cursors, retention and listing freshness are kernel-wide protocols
  with per-list adapters, so curated, dynamic and every other list-like view reuse them.

## Order of work

The owners adopt the research's ordered contract changes, starting with library profiles in definitions,
independent labels beside the exclusive state, and dynamic Collection membership; typed holdings and account imports
follow.
