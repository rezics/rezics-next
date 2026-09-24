/** A small, factual Wikidata entity projection. No descriptions or media are retained. */
export interface FixtureSource {
  name: string;
  minimumIntervalMs: number;
  requests: readonly { id: string; url: string }[];
  reuseBasis: string;
  normalize(raw: unknown, id: string): unknown;
}

export interface WikidataFact {
  id: string;
  revision: number;
  labels: { language: string; value: string }[];
}

export const wikidata: FixtureSource = {
  name: 'wikidata',
  minimumIntervalMs: 1000,
  requests: [{ id: 'Q42', url: 'https://www.wikidata.org/wiki/Special:EntityData/Q42.json' }],
  reuseBasis: 'Wikidata structured data CC0; retain only Q42 identifier, revision and en/ja/zh labels. No article text, descriptions, references, images or external database content. https://www.wikidata.org/wiki/Wikidata:Licensing',
  normalize(raw: unknown, id: string): WikidataFact {
    const root = raw as { entities?: Record<string, {
      id?: unknown; lastrevid?: unknown; labels?: Record<string, { language?: unknown; value?: unknown }> }> };
    const entity = root?.entities?.[id];
    if (!entity || entity.id !== id || !Number.isSafeInteger(entity.lastrevid)
      || !entity.labels || typeof entity.labels !== 'object') {
      throw new Error(`Malformed Wikidata entity ${id}`);
    }
    const labels = ['en', 'ja', 'zh'].flatMap(language => {
      const label = entity.labels?.[language];
      return label?.language === language && typeof label.value === 'string' && label.value.trim()
        ? [{ language, value: label.value.normalize('NFC') }] : [];
    });
    if (!labels.length) throw new Error(`Wikidata entity ${id} has no selected labels`);
    return { id, revision: entity.lastrevid as number, labels };
  },
};

export const sources: readonly FixtureSource[] = [wikidata];
