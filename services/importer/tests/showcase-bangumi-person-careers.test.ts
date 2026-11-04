import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { emptyCrossMediaPlan } from '../src/cross-media-seed.ts';
import { acquireBangumiPersonCareerSources } from '../src/showcase-bangumi-careers.ts';
import { ShowcaseJournal } from '../src/showcase-publication.ts';

test('selected actual Persons use bounded API career fallback and sealed source replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-person-careers-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const plan = emptyCrossMediaPlan();
    plan.entities.bangumi.push(
      {
        source: 'bangumi',
        key: 'person:8101',
        revision: 'archive-v1',
        payload: { id: 8101, type: 1, name: '星見', summary: 'Biography retained.' },
      },
      {
        source: 'bangumi',
        key: 'person:8102',
        revision: null,
        payload: { id: 8102, type: 1, name: 'Archive role', career: [] },
      },
      {
        source: 'bangumi',
        key: 'person:8103',
        revision: null,
        payload: { id: 8103, type: 2, name: 'Organization' },
      },
      {
        source: 'bangumi',
        key: 'person:8104',
        revision: null,
        payload: { id: 8104, type: 1, name: 'Unselected' },
      },
      {
        source: 'bangumi',
        key: 'person:8105',
        revision: null,
        payload: { id: 8105, type: 1, name: 'Malformed API role' },
      },
    );
    for (const id of [8101, 8102, 8103, 8105])
      plan.members.push({ source: 'bangumi', key: `person:${id}`, kind: 'person', membership: 'referenced' });

    const requests: string[] = [];
    const bodies = new Map([
      [8101, JSON.stringify({ id: 8101, career: ['producer', 'writer'] })],
      [8105, JSON.stringify({ id: 9999, career: ['actor'] })],
    ]);
    const fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const id = Number(url.slice(url.lastIndexOf('/') + 1));
      return new Response(bodies.get(id), { headers: { etag: `"person-${id}-v1"` } });
    }) as typeof globalThis.fetch;
    const selected = await acquireBangumiPersonCareerSources(plan, {
      journal,
      fetch,
      sleep: async () => {},
    });

    expect(requests).toEqual(['https://api.bgm.tv/v0/persons/8101', 'https://api.bgm.tv/v0/persons/8105']);
    const person = selected.entities.bangumi.find(({ key }) => key === 'person:8101')!;
    expect(person.payload).toMatchObject({
      id: 8101,
      type: 1,
      name: '星見',
      summary: 'Biography retained.',
      career: ['producer', 'writer'],
    });
    expect(selected.entities.bangumi.find(({ key }) => key === 'person:8102')?.payload).toHaveProperty('career', []);
    expect(selected.entities.bangumi.find(({ key }) => key === 'person:8103')?.payload).not.toHaveProperty('career');
    expect(selected.entities.bangumi.find(({ key }) => key === 'person:8105')?.payload).not.toHaveProperty('career');
    expect(selected.gaps).toContainEqual(
      expect.objectContaining({ externalId: 'person:8105', property: 'wdt:P106', fields: ['person.career'] }),
    );
    const source = selected.personCareerSources?.[0];
    expect(source).toMatchObject({
      sourceAlias: 'bangumi_cross_media',
      externalId: 'person:8101',
      sourceRevision: 'archive-v1',
      endpoint: 'https://api.bgm.tv/v0/persons/8101',
      sourceStatus: 'available',
      careers: ['producer', 'writer'],
      etag: '"person-8101-v1"',
      responseDigest: createHash('sha256').update(bodies.get(8101)!).digest('hex'),
    });

    journal.close();
    const reopened = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    try {
      const replay = await acquireBangumiPersonCareerSources(plan, {
        journal: reopened,
        fetch: (async () => {
          throw new Error('sealed career source unexpectedly fetched again');
        }) as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      });
      expect(replay.entities.bangumi.find(({ key }) => key === 'person:8101')?.payload).toHaveProperty(
        'career',
        ['producer', 'writer'],
      );
      expect(replay.personCareerSources).toEqual(selected.personCareerSources);
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
