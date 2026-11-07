/** The 31 first-public Semantic catalogue and Zone journeys from docs/goals/semantic.capabilities.md. */
export const LAUNCH_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
export const PRIMARY_LOCALES = ['en', 'zh-Hant', 'ja'] as const;

export type FirstPublicJourneyId =
  | 'released-definitions'
  | 'catalogue-browsing'
  | 'generic-creation'
  | 'book-and-series-editing'
  | 'recipe-editing'
  | 'game-and-visual-novel-editing'
  | 'addon-editing'
  | 'manga-editing'
  | 'screen-editing'
  | 'album-editing'
  | 'publication-editing'
  | 'music-context-editing'
  | 'file-and-release-group-editing'
  | 'work-part-editing'
  | 'character-identity-and-credit'
  | 'person-and-organization-editing'
  | 'concept-and-scheme-editing'
  | 'multilingual-terms'
  | 'cited-fact-correction'
  | 'original-authored-text'
  | 'relationship-correction'
  | 'missing-related-work'
  | 'identifier-evidence'
  | 'why-this-value-and-history'
  | 'context-creation'
  | 'context-editorial-decisions'
  | 'statement-consent'
  | 'subject-lifecycle'
  | 'zone-creation-and-configuration'
  | 'zone-publication-and-navigation'
  | 'zone-lifecycle-and-moderation';

export type FirstPublicJourney = {
  id: FirstPublicJourneyId;
  name: string;
  path: string;
  native: string;
  browser: string;
  type?: string;
};

export const FIRST_PUBLIC_JOURNEYS: readonly FirstPublicJourney[] = [
  {
    id: 'released-definitions',
    name: 'Released definitions',
    path: '/{locale}/catalogue/definitions',
    native:
      'GET /v1/definitions, /v1/definitions/active, /v1/definitions/releases/{digest}, /v1/definitionTypes?typeId=',
    browser: '/en/catalogue/definitions?type=schema:Book',
  },
  {
    id: 'catalogue-browsing',
    name: 'Catalogue browsing',
    path: '/{locale}/catalogue/{profile}',
    native: 'POST /v1/subjects:search type in released Book; GET /v1/subjects/{id}',
    browser: '/en/catalogue/literary then canonical subject reader',
    type: 'schema:Book',
  },
  {
    id: 'generic-creation',
    name: 'Generic creation',
    path: '/{locale}/catalogue/new',
    native: 'POST /v1/subjects schema:Book; independent GET of the returned id',
    browser: '/en/catalogue/new',
    type: 'schema:Book',
  },
  {
    id: 'book-and-series-editing',
    name: 'Book and series editing',
    path: '/{locale}/catalogue/literary',
    native: 'POST schema:Book and schema:BookSeries; cited wdt:P179 proposal; public read',
    browser: '/en/catalogue/literary',
    type: 'schema:Book',
  },
  {
    id: 'recipe-editing',
    name: 'Recipe editing',
    path: '/{locale}/catalogue/recipe',
    native: 'POST schema:Recipe with cookTime; independent public read',
    browser: '/en/catalogue/recipe',
    type: 'schema:Recipe',
  },
  {
    id: 'game-and-visual-novel-editing',
    name: 'Game and visual-novel editing',
    path: '/{locale}/catalogue/game',
    native: 'POST schema:VideoGame and wd:Q689445 as distinct identities',
    browser: '/en/catalogue/game',
    type: 'schema:VideoGame',
  },
  {
    id: 'addon-editing',
    name: 'Add-on editing',
    path: '/{locale}/catalogue/addon',
    native: 'POST wd:Q209163 with cited wdt:P8646 to the base work',
    browser: '/en/catalogue/addon',
    type: 'wd:Q209163',
  },
  {
    id: 'manga-editing',
    name: 'Manga editing',
    path: '/{locale}/catalogue/manga',
    native: 'POST schema:ComicSeries; independent reader',
    browser: '/en/catalogue/manga',
    type: 'schema:ComicSeries',
  },
  {
    id: 'screen-editing',
    name: 'Screen editing',
    path: '/{locale}/catalogue/screen',
    native: 'POST schema:Movie; independent reader',
    browser: '/en/catalogue/screen',
    type: 'schema:Movie',
  },
  {
    id: 'album-editing',
    name: 'Album editing',
    path: '/{locale}/catalogue/album',
    native: 'POST schema:MusicAlbum; independent reader',
    browser: '/en/catalogue/album',
    type: 'schema:MusicAlbum',
  },
  {
    id: 'publication-editing',
    name: 'Publication editing',
    path: '/{locale}/catalogue/publication',
    native: 'POST bf:Instance with cited schema:exampleOfWork; independent reader',
    browser: '/en/catalogue/publication',
    type: 'bf:Instance',
  },
  {
    id: 'music-context-editing',
    name: 'Music-context editing',
    path: '/{locale}/catalogue/music-context',
    native: 'POST schema:MusicVenue; independent reader',
    browser: '/en/catalogue/music-context',
    type: 'schema:MusicVenue',
  },
  {
    id: 'file-and-release-group-editing',
    name: 'File and release-group editing',
    path: '/{locale}/catalogue/file',
    native: 'POST schema:MediaObject and rezics:ReleaseGroup; independent readers',
    browser: '/en/catalogue/file',
    type: 'schema:MediaObject',
  },
  {
    id: 'work-part-editing',
    name: 'Work-part editing',
    path: 'Subject → work-parts editor',
    native: 'POST wd:Q2620972; cited rezics:storyArc on the work',
    browser: '/en/subjects/{id}/{slug}/work-parts',
    type: 'wd:Q2620972',
  },
  {
    id: 'character-identity-and-credit',
    name: 'Character identity and credit',
    path: '/{locale}/catalogue/character?work={id}',
    native: 'POST wd:Q95074; cited schema:character on the work',
    browser: '/en/catalogue/character',
    type: 'wd:Q95074',
  },
  {
    id: 'person-and-organization-editing',
    name: 'Person and organization editing',
    path: '/{locale}/catalogue/people',
    native: 'POST schema:Person and schema:Organization; independent readers',
    browser: '/en/catalogue/people',
    type: 'schema:Person',
  },
  {
    id: 'concept-and-scheme-editing',
    name: 'Concept and scheme editing',
    path: '/{locale}/catalogue/concept',
    native: 'POST skos:ConceptScheme and skos:Concept with cited skos:inScheme',
    browser: '/en/catalogue/concept',
    type: 'skos:Concept',
  },
  {
    id: 'multilingual-terms',
    name: 'Multilingual terms',
    path: 'Subject → Contribute → names/descriptions',
    native: 'PATCH /v1/subjects/{id}/terms; independent GET',
    browser: '/en/subjects/{id}/{slug}/terms',
  },
  {
    id: 'cited-fact-correction',
    name: 'Cited fact correction',
    path: 'Subject → Contribute → fact editor',
    native: 'POST /v1/subjects/{id}/candidates cited schema:inLanguage; independent candidate and public reads',
    browser: '/en/subjects/{id}/{slug}/edit',
  },
  {
    id: 'original-authored-text',
    name: 'Original authored text',
    path: 'Subject → authored editor',
    native: 'POST cited schema:abstract candidate; independent candidate vs public selected text',
    browser: '/en/subjects/{id}/{slug}/authored',
  },
  {
    id: 'relationship-correction',
    name: 'Relationship correction',
    path: 'Subject → relation editor',
    native: 'POST cited schema:author to an exact Person; independent relation read',
    browser: '/en/subjects/{id}/{slug}/relations',
  },
  {
    id: 'missing-related-work',
    name: 'Missing related work',
    path: 'Subject relationship editor → missing-work handoff',
    native: 'POST related identity then cited wdt:P179; independent reads of both',
    browser: '/en/catalogue/new return into the relation editor',
  },
  {
    id: 'identifier-evidence',
    name: 'Identifier evidence',
    path: 'Subject → identifiers',
    native: 'POST cited schema:sameAs candidate; independent candidate vs public identifier',
    browser: '/en/subjects/{id}/{slug}/identifiers',
  },
  {
    id: 'why-this-value-and-history',
    name: 'Why this value and history',
    path: 'Subject selected value → Why this value → Sources/Changes',
    native: 'GET candidate then GET /v1/subjects/{id} history surfaces',
    browser: '/en/subjects/{id}/{slug}/value and /changes',
  },
  {
    id: 'context-creation',
    name: 'Context creation',
    path: '/{locale}/my/contexts/new',
    native: 'POST /v1/contexts; independent GET of the returned Context',
    browser: '/en/my/contexts/new',
  },
  {
    id: 'context-editorial-decisions',
    name: 'Context editorial decisions',
    path: 'Subject → context-review',
    native: 'accept then adopt a cited candidate; compare Context and Global public selection',
    browser: '/en/subjects/{id}/{slug}/context-review',
  },
  {
    id: 'statement-consent',
    name: 'Statement consent',
    path: 'Subject → statement-consent',
    native: 'POST /v1/statements/{id}:disclose or :retract; independent public read',
    browser: '/en/subjects/{id}/{slug}/statement-consent',
  },
  {
    id: 'subject-lifecycle',
    name: 'Subject lifecycle',
    path: 'Owned Subject → delete/restore',
    native: 'DELETE then restoreDeleted on the owned candidate; owner vs public disclosure',
    browser: 'owned contribution controls on the current reader',
  },
  {
    id: 'zone-creation-and-configuration',
    name: 'Zone creation and configuration',
    path: '/{locale}/my/zones/new',
    native: 'POST /v1/zones; PUT configuration with static documents and empty mounts; GET configuration',
    browser: '/en/my/zones/new then /en/my/zones/{id}/edit',
  },
  {
    id: 'zone-publication-and-navigation',
    name: 'Zone publication and navigation',
    path: 'Configured static Zone → publish → anonymous /zones/{id}/{route}',
    native: 'POST :publish; anonymous POST :readPage for home and a configured route',
    browser: '/en/zones/{id} and /en/zones/{id}/about',
  },
  {
    id: 'zone-lifecycle-and-moderation',
    name: 'Zone lifecycle and moderation',
    path: 'Owned static Zone → delete → restore; pointer takedown',
    native: 'DELETE /v1/zones/{id}; anonymous 404; :restore; :takedown of /labels/en',
    browser: '/en/zones/{id} unavailable then restored',
  },
];

export function firstPublicJourney(id: FirstPublicJourneyId): FirstPublicJourney {
  const journey = FIRST_PUBLIC_JOURNEYS.find((row) => row.id === id);
  if (!journey) throw new Error(`unknown first-public journey ${id}`);
  return journey;
}
