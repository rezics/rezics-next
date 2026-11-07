import { CollectionDiscoveryCard } from './card';
import type { PublicCollectionSummary } from './read';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';

/** The existing native-card and compatibility-summary presentations share the Search producer. */
export function renderPublicCollection(collection: PublicCollectionSummary, locale: string) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  if (collection.card) return <CollectionDiscoveryCard card={collection.card} locale={locale} />;
  return (
    <>
      <a
        href={`/${locale}/collections/${encodeURIComponent(collection.id)}`}
        lang={collection.titleLanguage}
        className="block min-h-11 rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {collection.title || m.subject_value_unlabelled({}, options)}
      </a>
      {collection.description ? (
        <p lang={collection.descriptionLanguage} className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {collection.description}
        </p>
      ) : null}
    </>
  );
}
