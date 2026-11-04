# Manga part reader

The ordinary Subject remains the identity for each Manga series, volume and disclosed part. The reader presents only
current composition rows whose relation definitions admit membership or edition meaning. It preserves the native
statement association, direction, source order, disclosed labels and qualifiers. Partial dates stay with the generic
Subject facts and heading because relation summaries do not supply them. Each link uses the exact target Subject ID.
Missing specialized chapter configuration stays unsupported while generic facts and relations remain available.

The existing `pages:read` composition supplies the Subject and bounded relation rows. The reader adds no part lookup,
definition fetch, progress overlay, write or private session read. `WORK_PARTS_PAGE_CAP` bounds rows at twenty. The
current return address carries the locale, selected Realm, view, node and opaque cursor; no previous windows or
whole-work membership set are retained. A source, release, locale, context, viewer, selected view or page-window
replacement retires the captured visit and offers an explicit current-page recovery link.

## Cost

- **Touches:** one bounded ordinary Subject composition per selected window, using already supplied definitions and native relation summaries. Preparing the domain projection adds no per-part network reads, public-to-private overlay or history enumeration. A deliberate next window performs one existing page-bound request; exact-part navigation starts that destination's existing reader, not a prefetch of all parts.
- **Bound:** reuse `WORK_PARTS_PAGE_CAP=20` and current composition/cursor byte caps. The model retains only the admitted current subject, bounded rows/qualifiers, one continuation and return address, with work O(current page fields + rows + admitted bytes). Do not retain old windows, whole-work membership sets or all release history in a new cache.
- **Growth check:** use the actual projection/loader at a fixed 20-row window while independently varying unrelated parts, selected-subject relation history and 1/10/100 sequential windows/retirements. Count dispatched composition/native calls, materialized/retained bytes and active controllers for populated, empty, sparse, withheld, unavailable and same-cursor retry. Assert fixed page-bounded work, no point-read fanout and no old retained windows. Existing native relation physical-plan acceptance stays Semantic-owned.
