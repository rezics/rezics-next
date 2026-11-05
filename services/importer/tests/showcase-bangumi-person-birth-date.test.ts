import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { emptyCrossMediaPlan } from '../src/cross-media-seed.ts';
import { acquireBangumiPersonSources } from '../src/showcase-bangumi-people.ts';
import { ShowcaseJournal } from '../src/showcase-publication.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { converter_revision } from '../../../packages/conversion/src/cross-media-entities.ts';
import { readDump } from '../src/dumps.ts';

const pinned = JSON.parse(
  readFileSync(new URL('./fixtures/bangumi-person-birth-date.json', import.meta.url), 'utf8'),
) as {
  id: number;
  type: number;
  name: string;
  birth_year: number;
  birth_mon: number;
  birth_day: number;
  sourceURL: string;
  responseDigest: string;
};

function personPlan(payload: Record<string, unknown>) {
  const plan = emptyCrossMediaPlan();
  plan.entities.bangumi.push({
    source: 'bangumi',
    key: `person:${payload.id as number}`,
    revision: null,
    payload,
  });
  plan.members.push({
    source: 'bangumi',
    key: `person:${payload.id as number}`,
    kind: 'person',
    membership: 'referenced',
  });
  return plan;
}

test('ordinary CLI person JSON and selected PersonDetail reuse one cited birth date', async () => {
  const dump = [];
  async function* personDump() {
    yield new TextEncoder().encode(
      `${JSON.stringify({
        id: pinned.id,
        type: pinned.type,
        name: pinned.name,
        career: ['mangaka'],
        birth_year: pinned.birth_year,
        birth_mon: pinned.birth_mon,
        birth_day: pinned.birth_day,
      })}\n`,
    );
  }
  for await (const row of readDump('bangumi', personDump())) dump.push(row);
  expect(dump).toEqual([
    expect.objectContaining({
      source: 'bangumi',
      key: 'person:641',
      revision: null,
    }),
  ]);
  const ordinary = createSourceRegistration('bangumi');
  const converted = ordinary.convert(
    { external_id: 'person:641', record_revision: null, record: dump[0]!.payload },
    { source: ordinary.source, subjectId: '11111111-1111-4111-8111-111111111111' },
  );
  const birth = converted.proposals.find(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:birthDate',
  );
  expect(birth?.source.converter_revision).toBe(converter_revision);
  expect(birth?.op === 'propose' ? birth.statement.value : undefined).toEqual({
    type: 'value',
    content: {
      time: '+1974-11-08T00:00:00Z',
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    },
  });

  const directory = await mkdtemp(join(tmpdir(), 'bangumi-person-birth-date-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const body = JSON.stringify({
    id: pinned.id,
    type: 1,
    name: pinned.name,
    birth_year: pinned.birth_year,
    birth_mon: pinned.birth_mon,
    birth_day: pinned.birth_day,
  });
  let reads = 0;
  const fetch = (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(pinned.sourceURL);
    reads += 1;
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  try {
    const archive = { id: pinned.id, type: 1, name: pinned.name, career: ['mangaka'] };
    const first = await acquireBangumiPersonSources(personPlan(archive), { journal, fetch, sleep: async () => {} });
    const again = await acquireBangumiPersonSources(personPlan(archive), { journal, fetch, sleep: async () => {} });
    expect(reads).toBe(1);
    expect(first.entities.bangumi[0]!.payload).toMatchObject({
      birth_year: 1974,
      birth_mon: 11,
      birth_day: 8,
    });
    expect(again.personSources).toEqual(first.personSources);
    expect(first.personSources?.[0]?.responseDigest).toBe(createHash('sha256').update(body).digest('hex'));
    expect(first.personSources?.[0]?.sourceStatus).toBe('available');

    const failed = await acquireBangumiPersonSources(personPlan(archive), {
      fetch: (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    expect(failed.entities.bangumi[0]!.payload).toEqual(archive);
    expect(failed.personSources?.[0]?.sourceStatus).toBe('unavailable');
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
