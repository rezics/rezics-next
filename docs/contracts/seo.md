# Discovery metadata and canonical delivery

## Public projection

SEO metadata is a disclosure-qualified projection of the selected Resource/Main
Version, language and presentation context. Canonical URLs identify the intended
resource/selection; external identifiers and route slugs do not replace native
identity. Structured data exports only supported, sourced semantic claims.

## Indexing policy

Private, erased, unavailable and unreviewed content cannot enter title, description,
preview image, sitemap or JSON-LD output. A public container does not disclose
private members. Metadata-only resources state their actual content availability.
Realm-specific pages preserve local selection and do not claim a different version
as their canonical body without an explicit relationship.

## Implementation

Generate bounded per-resource projection after accepted changes; maintain paged
sitemaps and invalidation queues. SSR and client navigation share resolution and
disclosure. Cache keys include context/selection and relevant security epochs.
Do not synchronously scan the entire graph to update one sitemap entry.
Test private transitions, canonical rename, language fallback and stale previews.
