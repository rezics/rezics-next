# Search rating population

Search keeps the rating population separate from resource membership. The committed ratingPopulation query field
contains one canonical Realm ID; a missing or empty field means the existing Global population. The filter field
continues to express authored Realm or Collection membership. Selecting a rating population never creates, removes,
or changes a membership condition. Search offers only the authorized Realm choices supplied by its native owner.

Realm rating order supports the standard question, descending published score, and one subject partition. Native
Search intersects the complete query and filter set before ranking. The Web control does not collect candidates,
compute Bayesian scores, or reorder a loaded preview. A sparse or empty native page can still have a continuation;
the continuation stays opaque and generation-bound. Changing order or population starts a fresh traversal. Browser
history restores the exact prior query, population and continuation.

## Native outcomes

The control preserves the selected population and explains each native outcome:

- **Ready:** the selected Realm’s standard-question order is available in one subject partition.
- **Preparing:** keep the current search basis and retry when the native index is ready.
- **Unavailable:** explain the failure and offer a fresh retry. Never substitute Global order or sort the loaded
  preview.
- **Refused:** keep the refusal useful by inviting a supported Realm choice, corrected search conditions, or
  Relevance. Do not reinterpret it as a Global request.
- **Generation change:** restart the same query, filters and population from a fresh first page. This is recovery, not
  an authored condition correction.

The control accepts only the native owner’s authorized population choices and outcome. It shows no Realm totals,
means, scores, readiness estimates or candidate counts. Private figures remain in the authorized native response
and do not enter public kind, card or index data. The Global standard-question and prior meaning remain unchanged.

The protected producer and its disclosure boundary are defined by
[the Realm rank source](../../../../services/kernel/src/rating/realm-rank.ts) and
[Rating’s protected Realm rank contract](../../../../services/kernel/src/rating/README.md#protected-realm-rank-source).
The installed [Search rating contract](../../../../services/kernel/src/search/README.md#global-rating-order) retains
query/filter integration and native cursor ownership.

Decision: Search uses the separate ratingPopulation field for the canonical Realm ID; blank or missing means
Global, and changing that basis clears the continuation.
