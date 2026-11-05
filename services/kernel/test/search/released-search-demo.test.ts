import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDriverClient } from './support/driver-client.ts';

const bytes = readFileSync(new URL('../../../../specs/fixtures/imports/wikidata/entity.json', import.meta.url));
const entity = JSON.parse(bytes.toString('utf8')) as {
  labels: { en: { value: string } };
  aliases: { en: { value: string }[] };
};

test('released-data journey imports the real pinned fixture then finds its alias with public kind base and facet', async () => {
  const client = createDriverClient();
  try {
    const driver = await client.init();
    const receipt = await client.importReleasedBook({ version: 1 });
    const request = {
      text: entity.aliases.en[0]!.value,
      languages: ['en'],
      descriptions: true,
      filter: { type: { in: ['schema:Book'] } },
    };
    const readyBy = Date.now() + 15_000;
    let response = await driver.request('anonymous', 'POST', '/v1/subjects:search', request);
    for (;;) {
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.subjects)).toBe(true);
      const observed = response.body.subjects as { id: string }[];
      for (const sentinel of [
        'UNKNOWN_PROPERTY_SENTINEL',
        'USER_POST_SENTINEL',
        'PRIVATE_ACCOUNT_SENTINEL',
        'PRIVATE_TEXT_SENTINEL',
      ])
        expect(JSON.stringify(response.body)).not.toContain(sentinel);
      expect(response.body).not.toHaveProperty('total');
      expect(Date.now()).toBeLessThanOrEqual(readyBy);
      if (observed.some((row) => row.id === receipt.subjectId)) break;
      expect(observed).toEqual([]);
      await Bun.sleep(Math.min(50, Math.max(0, readyBy - Date.now())));
      expect(Date.now()).toBeLessThan(readyBy);
      response = await driver.request('anonymous', 'POST', '/v1/subjects:search', request);
    }
    expect(response.status).toBe(200);
    const rows = response.body.subjects as {
      id: string;
      type: string;
      kind: string;
      labels: Record<string, string>;
      base: { id: string; title: { value: string; language: string }; url: { id: string } };
    }[];
    const book = rows.find((row) => row.labels.en === entity.labels.en.value);
    expect(book).toBeDefined();
    expect(rows.map((row) => row.id)).toEqual([receipt.subjectId]);
    expect(book!.id).toBe(receipt.subjectId);
    expect(book!.type).toBe('schema:Book');
    expect(book!.kind).toBe('schema:Book');
    expect(book!.base.id).toBe(book!.id);
    expect(book!.base.url.id).toBe(book!.id);
    expect(book!.base.title).toEqual({ value: entity.labels.en.value, language: 'en' });
    const kinds = response.body.kinds as { values: { value: string; count?: { value: number; exact: boolean } }[] };
    const shown = kinds.values.find((value) => value.value === 'schema:Book');
    expect(shown?.count?.value).toBeGreaterThan(0);
    expect(shown!.count!.exact).toBe(false);
    const serialized = JSON.stringify(response.body);
    for (const sentinel of [
      'UNKNOWN_PROPERTY_SENTINEL',
      'USER_POST_SENTINEL',
      'PRIVATE_ACCOUNT_SENTINEL',
      'PRIVATE_TEXT_SENTINEL',
    ])
      expect(serialized).not.toContain(sentinel);
    expect(response.body).not.toHaveProperty('total');
    console.log(
      'released-search-native-demo',
      JSON.stringify({
        fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
        subject: book!.id,
        query: entity.aliases.en[0]!.value,
        status: response.status,
        kind: book!.kind,
        count: shown!.count,
      }),
    );
  } finally {
    await client.close();
  }
}, 300_000);
