import type { FixtureRequest, FixtureSource } from './wikidata.ts';

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

export const prideEditionSet = [
  { purpose: 'translation', edition: 'OL40859253M' },
  { purpose: 'publisher-dell', edition: 'OL51673567M' },
  { purpose: 'publisher-cambridge', edition: 'OL51047237M' },
  { purpose: 'annotated', edition: 'OL29868651M' },
  { purpose: 'ebook', edition: 'OL24284619M' },
  { purpose: 'audiobook', edition: 'OL26394110M' },
] as const;

/** Fixed Work and cover-edition keys selected from Open Library's fiction search on 2026-10-11. */
const librarySlicePairs: readonly (readonly [string, string])[] = [
  ['OL19096402W', 'OL28025498M'],
  ['OL450063W', 'OL35649409M'],
  ['OL17850410W', 'OL26694821M'],
  ['OL52266W', 'OL24269941M'],
  ['OL18020194W', 'OL30570882M'],
  ['OL34774028W', 'OL48316907M'],
  ['OL2895536W', 'OL8864633M'],
  ['OL19963111W', 'OL27143333M'],
  ['OL52267W', 'OL27553880M'],
  ['OL257746W', 'OL24206623M'],
  ['OL21177W', 'OL38586477M'],
  ['OL77748W', 'OL40272709M'],
  ['OL59798W', 'OL9137999M'],
  ['OL19713513W', 'OL26926650M'],
  ['OL455305W', 'OL7173915M'],
  ['OL17715454W', 'OL26316828M'],
  ['OL468431W', 'OL22570129M'],
  ['OL52114W', 'OL9236546M'],
  ['OL676009W', 'OL39822642M'],
  ['OL1418187W', 'OL9506915M'],
  ['OL81633W', 'OL22312685M'],
  ['OL1230715W', 'OL21317954M'],
  ['OL69612W', 'OL37044748M'],
  ['OL39349W', 'OL24250155M'],
  ['OL18417W', 'OL8155451M'],
  ['OL731737W', 'OL8663940M'],
  ['OL77826W', 'OL631433M'],
  ['OL731644W', 'OL7771108M'],
  ['OL2718328W', 'OL5536772M'],
  ['OL27495W', 'OL18768117M'],
  ['OL85892W', 'OL35373336M'],
  ['OL62979W', 'OL9274797M'],
  ['OL27513W', 'OL51708686M'],
  ['OL25363307W', 'OL35586900M'],
  ['OL69630W', 'OL10129073M'],
  ['OL20068530W', 'OL27248516M'],
  ['OL21025633W', 'OL28485952M'],
  ['OL262460W', 'OL22885694M'],
  ['OL43113687W', 'OL58722495M'],
  ['OL1230613W', 'OL6508147M'],
  ['OL471603W', 'OL50983631M'],
  ['OL66513W', 'OL13573615M'],
  ['OL46125W', 'OL51565403M'],
  ['OL19737574W', 'OL27332833M'],
  ['OL74504W', 'OL24132364M'],
  ['OL17812914W', 'OL28678192M'],
  ['OL498556W', 'OL26965562M'],
  ['OL46398W', 'OL15178189M'],
  ['OL1099513W', 'OL7027686M'],
  ['OL10263W', 'OL7366018M'],
  ['OL3140822W', 'OL26467746M'],
  ['OL17797130W', 'OL26386597M'],
  ['OL82563W', 'OL61027601M'],
  ['OL19747970W', 'OL28418464M'],
  ['OL2172454W', 'OL9828462M'],
  ['OL82537W', 'OL59041259M'],
  ['OL46401W', 'OL21942784M'],
  ['OL34965326W', 'OL47327177M'],
  ['OL24156W', 'OL3682767M'],
  ['OL486967W', 'OL20161132M'],
  ['OL1865528W', 'OL21389163M'],
  ['OL1168007W', 'OL23269355M'],
  ['OL77744W', 'OL33059944M'],
  ['OL2775807W', 'OL8978515M'],
  ['OL30457295W', 'OL9175495M'],
  ['OL2096536W', 'OL17721910M'],
  ['OL17610507W', 'OL26214600M'],
  ['OL21745884W', 'OL32553390M'],
  ['OL1737320W', 'OL22789812M'],
  ['OL8400950W', 'OL7878939M'],
  ['OL35616W', 'OL24284992M'],
  ['OL76835W', 'OL50365295M'],
  ['OL103123W', 'OL40236195M'],
  ['OL38501W', 'OL7599585M'],
  ['OL472549W', 'OL6670431M'],
  ['OL109524W', 'OL35607043M'],
  ['OL927199W', 'OL37809163M'],
  ['OL17710016W', 'OL30198538M'],
  ['OL66554W', 'OL47044678M'],
  ['OL893414W', 'OL32848840M'],
  ['OL66562W', 'OL14041582M'],
  ['OL36287W', 'OL46867087M'],
  ['OL679358W', 'OL47552519M'],
  ['OL71042W', 'OL9248118M'],
  ['OL8127201W', 'OL8204926M'],
  ['OL46881W', 'OL38582593M'],
  ['OL16314245W', 'OL27897732M'],
  ['OL453661W', 'OL7575774M'],
  ['OL111439W', 'OL12716820M'],
  ['OL166894W', 'OL9004678M'],
  ['OL263301W', 'OL797613M'],
  ['OL63985W', 'OL7053656M'],
  ['OL5714301W', 'OL32211338M'],
  ['OL2163649W', 'OL17837787M'],
  ['OL1833989W', 'OL22282645M'],
  ['OL46876W', 'OL31981279M'],
  ['OL17370186W', 'OL35136778M'],
  ['OL20145719W', 'OL27325416M'],
  ['OL17076678W', 'OL25646464M'],
  ['OL21435W', 'OL24389148M'],
  ['OL20090688W', 'OL27270721M'],
  ['OL18766691W', 'OL26702293M'],
  ['OL472715W', 'OL46918364M'],
  ['OL18543708W', 'OL26694815M'],
  ['OL5714284W', 'OL32211349M'],
  ['OL15056584W', 'OL1702950M'],
  ['OL492647W', 'OL42345607M'],
  ['OL16813331W', 'OL25439048M'],
  ['OL1167981W', 'OL3672935M'],
  ['OL453658W', 'OL47800506M'],
  ['OL53994W', 'OL7025266M'],
  ['OL27482W', 'OL51711263M'],
  ['OL46390W', 'OL18383124M'],
  ['OL20018811W', 'OL27824009M'],
  ['OL17797857W', 'OL34988571M'],
  ['OL471789W', 'OL51162345M'],
  ['OL472073W', 'OL51017254M'],
  ['OL492646W', 'OL7359831M'],
  ['OL18012166W', 'OL26855753M'],
  ['OL262438W', 'OL13492734M'],
  ['OL14917748W', 'OL23224107M'],
  ['OL262505W', 'OL20548211M'],
  ['OL77775W', 'OL52248106M'],
  ['OL453697W', 'OL7275645M'],
  ['OL1963251W', 'OL7959658M'],
];
const librarySliceRequest: FixtureRequest = {
  id: 'library-slice-2026-10-11-250-records',
  url: `https://openlibrary.org/works/${librarySlicePairs[0]![0]}.json`,
  records: librarySlicePairs.flatMap(([work, edition]) => [
    { id: `work-${work}`, url: `https://openlibrary.org/works/${work}.json` },
    { id: `edition-${edition}`, url: `https://openlibrary.org/books/${edition}.json` },
  ]),
};

export const openLibraryLibrarySlice = {
  id: librarySliceRequest.id,
  recordCount: librarySliceRequest.records!.length,
};

const authorIds = [
  'OL21594A',
  'OL22098A',
  'OL161167A',
  'OL113362A',
  'OL25342A',
  'OL26680A',
  'OL23767A',
  'OL608235A',
  'OL15030763A',
  'OL15811481A',
  'OL68149A',
  'OL15669783A',
  'OL16184674A',
  'OL6725631A',
  'OL4288487A',
  'OL15109279A',
] as const;

export const openLibrary: FixtureSource = {
  name: 'open-library',
  minimumIntervalMs: 1000,
  requests: [
    ...demoClassics.flatMap(({ work, edition }) => [
      { id: `work-${work}`, url: `https://openlibrary.org/works/${work}.json` },
      { id: `edition-${edition}`, url: `https://openlibrary.org/books/${edition}.json` },
    ]),
    ...prideEditionSet.map(({ edition }) => ({
      id: `edition-${edition}`,
      url: `https://openlibrary.org/books/${edition}.json`,
    })),
    librarySliceRequest,
    ...authorIds.map((author) => ({
      id: `author-${author}`,
      url: `https://openlibrary.org/authors/${author}.json`,
    })),
  ],
  reuseBasis:
    'Open Library catalog metadata is released under CC0; JSON API records only, no book text or cover images. https://openlibrary.org/help/faq/using',
  normalize(raw: unknown, id: string): unknown {
    if (id === librarySliceRequest.id) {
      const bundle = raw as { records?: { id?: unknown; record?: unknown }[] } | null;
      const expected = librarySliceRequest.records ?? [];
      if (!bundle || !Array.isArray(bundle.records) || bundle.records.length !== expected.length) {
        throw new Error(`Malformed Open Library ${id}`);
      }
      const records = bundle.records.map((item, index) => {
        const request = expected[index]!;
        if (item.id !== request.id)
          throw new Error(`Unexpected Open Library ${id} member ${String(item.id)}`);
        return { id: request.id, record: normalizeRecord(item.record, request.id) };
      });
      return { id, recordCount: records.length, records };
    }
    return normalizeRecord(raw, id);
  },
};

function normalizeRecord(raw: unknown, id: string): unknown {
  const body = raw as {
    key?: unknown;
    title?: unknown;
    name?: unknown;
    type?: { key?: unknown } | string;
    revision?: unknown;
    works?: { key?: unknown }[];
    authors?: unknown[];
  } | null;
  const [, kind, record] = /^(work|edition|author)-(OL[1-9][0-9]*(?:W|M|A))$/.exec(id) ?? [];
  const key =
    kind === 'work'
      ? `/works/${record}`
      : kind === 'edition'
        ? `/books/${record}`
        : `/authors/${record}`;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    body.key !== key ||
    !Number.isSafeInteger(body.revision) ||
    (kind === 'author' ? typeof body.name !== 'string' : typeof body.title !== 'string') ||
    (kind === 'work' && !Array.isArray(body.authors)) ||
    (kind === 'edition' && !Array.isArray(body.works))
  ) {
    throw new Error(`Malformed Open Library ${id}`);
  }
  // Preserve the complete API record: source conversion requires complete coverage.
  return raw;
}
