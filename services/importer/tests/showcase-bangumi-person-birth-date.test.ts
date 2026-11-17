import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { crossMediaAliases, emptyCrossMediaPlan } from '../src/cross-media-seed.ts';
import { acquireBangumiPersonSources } from '../src/showcase-bangumi-people.ts';
import { ShowcaseJournal } from '../src/showcase-publication.ts';
import {
  createSelectedFamilySourceRegistration,
  createSourceRegistration,
  crossMediaBangumiRevision,
} from '../src/source-registry.ts';
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
  personURL: string;
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

function birthProposal(commands: readonly BatchCommand[]) {
  const births = commands.filter(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === 'schema:birthDate',
  );
  expect(births).toHaveLength(1);
  return births[0]!;
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
  const subjectId = '11111111-1111-4111-8111-111111111111';
  const converted = ordinary.convert(
    { external_id: 'person:641', record_revision: null, record: dump[0]!.payload },
    { source: ordinary.source, subjectId },
  );
  const birth = birthProposal(converted.proposals);
  expect(birth.source).toMatchObject({
    source: 'bangumi',
    external_id: 'person:641',
    record_revision: 'unversioned',
    converter_revision: bangumiRevision,
  });
  expect(birth.statement.value).toEqual({
    type: 'value',
    content: {
      time: '+1974-11-08T00:00:00Z',
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    },
  });
  expect(birth.statement.references).toEqual([
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: pinned.personURL } }] },
  ]);

  const directory = await mkdtemp(join(tmpdir(), 'bangumi-person-birth-date-'));
  const path = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(path);
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
    journal.close();
    journal = new ShowcaseJournal(path);
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
    const selected = createSelectedFamilySourceRegistration('bangumi', crossMediaAliases.bangumi);
    const convertSelected = (plan: typeof first) => {
      const person = plan.entities.bangumi[0]!;
      return selected.convert(
        { external_id: person.key, record_revision: person.revision, record: person.payload },
        { source: selected.source, subjectId },
      );
    };
    const selectedBirth = birthProposal(convertSelected(first).proposals);
    expect(selectedBirth).toMatchObject({
      subject: subjectId,
      source: {
        source: crossMediaAliases.bangumi,
        external_id: 'person:641',
        record_revision: 'unversioned',
        converter_revision: crossMediaBangumiRevision,
      },
    });
    expect(selectedBirth.statement).toEqual(birth.statement);
    expect(birthProposal(convertSelected(again).proposals)).toEqual(selectedBirth);

    const failed = await acquireBangumiPersonSources(personPlan(archive), {
      fetch: (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    expect(failed.entities.bangumi[0]!.payload).toEqual(archive);
    expect(failed.personSources?.[0]?.sourceStatus).toBe('unavailable');
    expect(
      convertSelected(failed).proposals.some(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:birthDate',
      ),
    ).toBe(false);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
