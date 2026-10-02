import type { Metadata } from 'next';
import { materializeData } from 'native-i18n';
import { notFound } from 'next/navigation';
import { ConceptMalformed, ConceptPage, ConceptUnavailable } from '../../../../features/concept/concept-page.tsx';
import { facetByRef, facetLabel } from '../../../../features/concept/facets.ts';
import { conceptReader, readConcept, readConceptFollow, readFacets, readFirstWorks,
  readScopeRealm } from '../../../../features/concept/read.ts';
import { parseConceptState } from '../../../../features/concept/state.ts';
import { idOf, type SearchParams } from '../../../../features/discover/scope.ts';
import { parseConceptRef } from '../../../../features/concept/route.ts';
import { pageUrl, representationPath } from '../../../../features/seo/address.ts';
import { Providers } from '../../../../features/shell/providers.tsx';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

type Props = { params: Promise<{ concept: string }>; searchParams: Promise<SearchParams> };

// Metadata reads the Concept directly and never throws notFound(): vinext
// streams metadata, so a 404 thrown there would answer 200. The page does.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const concept = parseConceptRef((await params).concept);
  if (!concept) return {};
  const locale = await requestLocale();
  const [read, messages] = await Promise.all([readConcept(concept, locale), getMessages('concept', locale)]);
  if (!read.ok) return {};
  const t = materializeData(messages, { locale });
  const name = read.data.name.value;
  const page = await pageUrl();
  return { title: t.metaTitle({ name }), description: read.data.description?.value ?? t.metaDescription({ name }),
    ...(page ? { alternates: { canonical: page.origin + representationPath(page) } } : {}) };
}

/**
 * `/concepts/{id}`: a public Concept's page with the Works that reach it,
 * narrowed by the Condition bar in the address. Any other ID is a 404.
 */
export default async function ConceptRoute({ params, searchParams }: Props) {
  const [path, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const concept = parseConceptRef(path.concept);
  if (!concept) notFound();
  const [read, facets, messages] = await Promise.all([readConcept(concept, locale), readFacets(),
    getMessages('concept', locale)]);
  if (!read.ok) {
    if (read.failure === 'missing' || read.failure === 'invalid') notFound();
    return <ConceptUnavailable state={null} locale={locale} messages={messages} />;
  }
  const facet = facetByRef(facets.ok ? facets.data : null, read.data.facet);
  const state = parseConceptState(concept, query, facet?.cost.maxValues);
  if (!state) return <ConceptMalformed concept={concept} locale={locale} messages={messages} />;
  const realms = [...new Set([state.scope.kind === 'realm' ? state.scope.realm : null, idOf(read.data.realm ?? '')])]
    .filter((realm): realm is string => !!realm);
  const [reader, works, follow, names] = await Promise.all([conceptReader(), readFirstWorks(state, locale),
    readConceptFollow(concept, locale), Promise.all(realms.map(realm => readScopeRealm(realm, locale)))]);
  return <Providers>
    <ConceptPage concept={read.data} facet={facet ? facetLabel(facet, locale) : null} state={state}
      realms={Object.fromEntries(realms.map((realm, index) => [realm, names[index] ?? null]))} works={works}
      follow={follow} reader={{ signedIn: reader.signedIn, actingSubject: reader.actingSubject,
        avatarQuery: reader.avatarQuery }} maxValues={facet?.cost.maxValues} locale={locale} messages={messages} />
  </Providers>;
}
