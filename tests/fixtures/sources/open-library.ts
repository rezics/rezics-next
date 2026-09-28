import type { FixtureSource } from './wikidata.ts';

/** Catalog records used by the demo seed. IDs resolve to Open Library JSON API records. */
export const demoClassics = [
  { id: 'pride', work: 'OL66554W', edition: 'OL49836838M' },
  { id: 'alice', work: 'OL138052W', edition: 'OL50383225M' },
  { id: 'sherlock', work: 'OL262421W', edition: 'OL37595955M' },
  { id: 'sherlock-scandal', work: 'OL14930611W', edition: 'OL35422426M' },
  { id: 'jane-eyre', work: 'OL1095427W', edition: 'OL44576899M' },
  { id: 'frankenstein', work: 'OL450063W', edition: 'OL62085812M' },
  { id: 'little-women', work: 'OL29983W', edition: 'OL43723716M' },
  { id: 'secret-garden', work: 'OL69612W', edition: 'OL62456547M' },
  { id: 'journey-west', work: 'OL43592659W', edition: 'OL59844600M' },
  { id: 'red-chamber', work: 'OL44028824W', edition: 'OL60086420M' },
  { id: 'strange-tales', work: 'OL43981488W', edition: 'OL59988960M' },
  { id: 'painted-skin', work: 'OL45094623W', edition: 'OL61503466M' },
  { id: 'three-kingdoms', work: 'OL13855988W', edition: 'OL23693859M' },
  { id: 'water-margin', work: 'OL43776831W', edition: 'OL59675577M' },
] as const;

const authorIds = [
  'OL21594A', 'OL22098A', 'OL161167A', 'OL113362A', 'OL25342A', 'OL26680A',
  'OL23767A', 'OL608235A', 'OL15030763A', 'OL15811481A', 'OL68149A',
  'OL15669783A', 'OL16184674A', 'OL6725631A', 'OL4288487A', 'OL15109279A',
] as const;

export const openLibrary: FixtureSource = {
  name: 'open-library',
  minimumIntervalMs: 1000,
  requests: [
    ...demoClassics.flatMap(({ work, edition }) => [
      { id: `work-${work}`, url: `https://openlibrary.org/works/${work}.json` },
      { id: `edition-${edition}`, url: `https://openlibrary.org/books/${edition}.json` },
    ]),
    ...authorIds.map(author => ({ id: `author-${author}`,
      url: `https://openlibrary.org/authors/${author}.json` })),
  ],
  reuseBasis: 'Open Library catalog metadata is released under CC0; JSON API records only, no book text or cover images. https://openlibrary.org/help/faq/using',
  normalize(raw: unknown, id: string): unknown {
    const body = raw as { key?: unknown; title?: unknown; name?: unknown;
      type?: { key?: unknown } | string; revision?: unknown; works?: { key?: unknown }[];
      authors?: unknown[] } | null;
    const [, kind, record] = /^(work|edition|author)-(OL[1-9][0-9]*(?:W|M|A))$/.exec(id) ?? [];
    const key = kind === 'work' ? `/works/${record}`
      : kind === 'edition' ? `/books/${record}` : `/authors/${record}`;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || body.key !== key || !Number.isSafeInteger(body.revision)
      || (kind === 'author' ? typeof body.name !== 'string' : typeof body.title !== 'string')
      || (kind === 'work' && !Array.isArray(body.authors))
      || (kind === 'edition' && !Array.isArray(body.works))) {
      throw new Error(`Malformed Open Library ${id}`);
    }
    // Preserve the complete API record: source conversion requires complete coverage.
    return raw;
  },
};
