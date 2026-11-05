import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { convertCrossMediaEntity } from '../../../packages/conversion/src/cross-media-entities.ts';
import { developmentShowcaseSelection } from '../../../scripts/datasets/cross-media-seed.ts';
import { emptyCrossMediaPlan } from '../src/cross-media-seed.ts';
import { acquireBangumiPersonCareerSources } from '../src/showcase-bangumi-careers.ts';
import { acquireBangumiCoverSources } from '../src/showcase-media.ts';
import { ShowcaseJournal } from '../src/showcase-publication.ts';

const evidence = JSON.parse(
  await readFile(new URL('../../../specs/fixtures/imports/bangumi/person-names.json', import.meta.url), 'utf8'),
) as {
  defaultSelection: {
    rootSubject: number;
    responseSha256: string;
    responseBody: string;
    person: { id: number; type: number; name: string; detailUrl: string; detailSha256: string; responseBody: string };
  };
};

function valueContent(command: Extract<BatchCommand, { op: 'propose' }>) {
  return command.statement.value.type === 'value' ? command.statement.value.content : undefined;
}

test('the default selected Person shares one bounded PersonDetail response for careers and Chinese names', async () => {
  const selection = evidence.defaultSelection;
  expect((developmentShowcaseSelection.bangumi as readonly number[]).includes(selection.rootSubject)).toBe(true);
  const selectedRows = JSON.parse(selection.responseBody) as { id: number; type: number; name: string }[];
  expect(createHash('sha256').update(selection.responseBody).digest('hex')).toBe(selection.responseSha256);
  expect(
    selectedRows.some(
      ({ id, type, name }) => id === selection.person.id && type === selection.person.type && name === selection.person.name,
    ),
  ).toBe(true);
  expect(createHash('sha256').update(selection.person.responseBody).digest('hex')).toBe(selection.person.detailSha256);

  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-person-names-'));
  const journalPath = join(directory, 'showcase.sqlite');
  const plan = emptyCrossMediaPlan();
  plan.entities.bangumi.push({
    source: 'bangumi',
    key: `person:${selection.person.id}`,
    revision: null,
    payload: { id: selection.person.id, type: 1, name: selection.person.name },
  });
  plan.members.push(
    { source: 'bangumi', key: String(selection.rootSubject), kind: 'work', membership: 'family' },
    { source: 'bangumi', key: `person:${selection.person.id}`, kind: 'person', membership: 'referenced' },
  );
  plan.creatorImageKeys = [`person:${selection.person.id}`];
  const requests: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(selection.person.responseBody, {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  const journal = new ShowcaseJournal(journalPath);
  try {
    const acquired = await acquireBangumiPersonCareerSources(plan, { journal, fetch, sleep: async () => {} });
    const person = acquired.entities.bangumi.find(({ key }) => key === `person:${selection.person.id}`)!;
    expect(requests).toEqual([selection.person.detailUrl]);
    expect(person.payload).toMatchObject({
      id: selection.person.id,
      type: 1,
      name: selection.person.name,
      name_cn: '美甘义人',
      career: ['producer'],
    });
    expect(acquired.personCareerSources?.[0]).toMatchObject({
      sourceRevision: 'unversioned',
      endpoint: selection.person.detailUrl,
      responseDigest: selection.person.detailSha256,
      personChineseName: '美甘义人',
      careers: ['producer'],
      personImageStatus: 'absent',
    });
    expect(acquired.personCareerSources?.[0]).not.toHaveProperty('etag');
    const withImage = await acquireBangumiCoverSources(acquired, { journal, fetch, sleep: async () => {} });
    expect(withImage.creatorImageSources?.[0]).toMatchObject({
      externalId: `person:${selection.person.id}`,
      endpoint: selection.person.detailUrl,
      responseDigest: selection.person.detailSha256,
      sourceStatus: 'absent',
    });
    expect(requests).toEqual([selection.person.detailUrl]);

    journal.close();
    const reopened = new ShowcaseJournal(journalPath);
    try {
      const replay = await acquireBangumiPersonCareerSources(plan, {
        journal: reopened,
        fetch: (async () => {
          throw new Error('sealed PersonDetail response unexpectedly fetched again');
        }) as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      });
      expect(replay.entities.bangumi.find(({ key }) => key === `person:${selection.person.id}`)?.payload).toMatchObject({
        name_cn: '美甘义人',
        career: ['producer'],
      });
      expect(replay.personCareerSources).toEqual(acquired.personCareerSources);
      expect(requests).toHaveLength(1);
    } finally {
      reopened.close();
    }
  } finally {
    try {
      journal.close();
    } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test('spoofed, absent and over-bound PersonDetail names preserve each independent original name', async () => {
  const plan = emptyCrossMediaPlan();
  for (const id of [641, 642, 643, 644]) {
    plan.entities.bangumi.push({
      source: 'bangumi',
      key: `person:${id}`,
      revision: null,
      payload: { id, type: 1, name: `Original ${id}` },
    });
    plan.members.push({ source: 'bangumi', key: `person:${id}`, kind: 'person', membership: 'referenced' });
  }
  const responses = new Map([
    [641, { id: 9001, type: 1, career: [], infobox: [{ key: '简体中文名', value: '伪造' }] }],
    [642, { id: 642, type: 2, career: [], infobox: [{ key: '简体中文名', value: '伪造' }] }],
    [643, { id: 643, type: 1, career: [] }],
    [644, { id: 644, type: 1, career: [], infobox: [{ key: '简体中文名', value: '超'.repeat(4097) }] }],
  ]);
  const requests: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const id = Number(url.slice(url.lastIndexOf('/') + 1));
    return Response.json(responses.get(id));
  }) as typeof globalThis.fetch;
  const acquired = await acquireBangumiPersonCareerSources(plan, { fetch, sleep: async () => {} });
  expect(requests).toEqual([641, 642, 643, 644].map((id) => `https://api.bgm.tv/v0/persons/${id}`));
  for (const row of acquired.entities.bangumi) {
    const payload = row.payload as { id: number };
    const converted = convertCrossMediaEntity(
      { external_id: row.key, record_revision: row.revision, record: row.payload },
      { source: 'bangumi_cross_media', subjectId: '11111111-1111-4111-8111-111111111111' },
      { sourceKind: 'bangumi' },
    );
    const names = converted.proposals.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:name',
    );
    expect(names.map(valueContent)).toEqual([
      { language: 'und', text: `Original ${payload.id}` },
    ]);
  }
  expect(acquired.gaps).toContainEqual(
    expect.objectContaining({ externalId: 'person:644', property: 'schema:name', fields: ['person.name_cn'] }),
  );
  for (const id of [641, 642])
    expect(acquired.gaps).toContainEqual(
      expect.objectContaining({ externalId: `person:${id}`, property: 'schema:name', fields: ['person.name_cn'] }),
    );
});
