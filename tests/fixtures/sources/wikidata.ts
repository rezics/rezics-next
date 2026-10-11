/** A small, factual Wikidata entity projection. No descriptions or media are retained. */
export interface FixtureSource {
  name: string;
  minimumIntervalMs: number;
  requests: readonly FixtureRequest[];
  reuseBasis: string;
  normalize(raw: unknown, id: string): unknown;
}

export interface WikidataFact {
  id: string;
  revision: number;
  labels: { language: string; value: string }[];
}

export interface FixtureRequest {
  id: string;
  url: string;
  maxResponseBytes?: number;
  records?: readonly { id: string; url: string }[];
}

export const wikidataAuthors = [
  { id: 'Q36322', labels: { en: 'Jane Austen' } },
  { id: 'Q4985', labels: { en: 'Herman Melville' } },
  { id: 'Q7243', labels: { en: 'Leo Tolstoy' } },
  { id: 'Q535', labels: { ja: 'ヴィクトル・ユーゴー', zh: '维克多·雨果' } },
  { id: 'Q1067', labels: { en: 'Dante Alighieri' } },
  { id: 'Q106143', labels: { en: 'Samuel Pepys' } },
  { id: 'Q7200', labels: { en: 'Alexander Pushkin', ja: 'アレクサンドル・プーシキン', zh: '亞歷山大·普希金' } },
  { id: 'Q6849599', labels: {} },
] as const;

export const wikidata: FixtureSource = {
  name: 'wikidata',
  minimumIntervalMs: 1000,
  requests: [{ id: 'Q42', url: 'https://www.wikidata.org/wiki/Special:EntityData/Q42.json' }],
  reuseBasis:
    'Wikidata structured data CC0; retain only Q42 identifier, revision and en/ja/zh labels. No article text, descriptions, references, images or external database content. https://www.wikidata.org/wiki/Wikidata:Licensing',
  normalize(raw: unknown, id: string): WikidataFact {
    const root = raw as {
      entities?: Record<
        string,
        {
          id?: unknown;
          lastrevid?: unknown;
          labels?: Record<string, { language?: unknown; value?: unknown }>;
        }
      >;
    };
    const entity = root?.entities?.[id];
    if (
      !entity ||
      entity.id !== id ||
      !Number.isSafeInteger(entity.lastrevid) ||
      !entity.labels ||
      typeof entity.labels !== 'object'
    ) {
      throw new Error(`Malformed Wikidata entity ${id}`);
    }
    const expectedLabels = wikidataAuthors.find((author) => author.id === id)?.labels;
    for (const [language, value] of Object.entries(expectedLabels ?? {})) {
      const label = entity.labels[language];
      if (
        label?.language !== language ||
        typeof label.value !== 'string' ||
        label.value.normalize('NFC') !== value
      ) {
        throw new Error(`Wikidata entity ${id} is not labelled ${value} (${language})`);
      }
    }
    const labels = ['en', 'ja', 'zh'].flatMap((language) => {
      const label = entity.labels?.[language];
      return label?.language === language && typeof label.value === 'string' && label.value.trim()
        ? [{ language, value: label.value.normalize('NFC') }]
        : [];
    });
    if (!labels.length && expectedLabels === undefined) throw new Error(`Wikidata entity ${id} has no selected labels`);
    return { id, revision: entity.lastrevid as number, labels };
  },
};

export const wikidataAuthorsSource: FixtureSource = {
  ...wikidata,
  reuseBasis:
    'Wikidata structured data CC0; retain only the item identifier, revision and en/ja/zh labels. No article text, descriptions, references, images or external database content. https://www.wikidata.org/wiki/Wikidata:Licensing',
  requests: wikidataAuthors.map(({ id }) => ({
    id,
    url: `https://www.wikidata.org/wiki/Special:EntityData/${id}.json`,
  })),
};

export const sources: readonly FixtureSource[] = [wikidata, wikidataAuthorsSource];
