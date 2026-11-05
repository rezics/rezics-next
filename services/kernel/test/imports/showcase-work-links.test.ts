import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { developmentShowcaseSelection } from '../../../../scripts/datasets/cross-media-seed.ts';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;
const sourceWork = 'v2002';
const animeWork = '10380';
const linkedUrl = `https://bgm.tv/subject/${animeWork}`;

function tables(value = linkedUrl): CrossMediaTables {
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') {
        yield { id: 10380, type: 2, name: 'STEINS;GATE' };
        yield { id: 84148, type: 1, name: 'STEINS;GATE' };
        yield { id: 51, type: 2, name: 'CLANNAD' };
      }
      if (provider !== 'vndb') return;
      if (table === 'vn') {
        yield { id: sourceWork, olang: 'ja', alias: null };
        yield { id: 'v4', olang: 'ja', alias: null };
      }
      if (table === 'vn_titles') {
        yield { id: sourceWork, lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null };
        yield { id: 'v4', lang: 'ja', official: 't', title: 'CLANNAD', latin: null };
      }
      if (table === 'entry_meta') {
        yield { id: sourceWork, revision: '7', lastmod: '2026-10-25' };
        yield { id: 'v4', revision: '8', lastmod: '2026-10-25' };
      }
      if (table === 'vn_extlinks') yield { id: sourceWork, link: 1 };
      if (table === 'extlinks') yield { id: 1, site: 'website', value };
    },
  };
}

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: {
    value: { content: unknown };
    references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
  };
  source?: {
    source: string;
    external_id: string;
    record_revision: string | null;
    converter_revision: string;
    digest: string;
  };
};

function subjectId(reading: { subject: unknown }): string {
  const result = reading.subject as { subject?: { id?: string }; id?: string };
  const id = result.subject?.id ?? result.id;
  if (!id) throw new TypeError('Seed reading has no acknowledged subject UUID');
  return id;
}

test('default seed publishes the cited VN work link on its own identity and refresh respects its facts fence', async () => {
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = tmpdir();
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'showcase-work-links-native-'));
  try {
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: randomUUID(), tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    async function candidates(subject: string, property: string) {
      const response = await editor.http(
        `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(response.status).toBe(200);
      return response.body as { candidates: Candidate[]; adoption: { head: number } | null };
    }
    async function acceptAdopt(subject: string, property: string) {
      const seen = new Set<string>();
      for (;;) {
        const listing = await candidates(subject, property);
        const next = listing.candidates.find(
          (candidate) => candidate.source && !candidate.retracted && !seen.has(candidate.id),
        );
        if (!next) {
          const live = listing.candidates.filter((candidate) => !candidate.retracted);
          if (!live.length) return;
          const adopted = await editor.http(`/v1/subjects/${subject}:adopt`, {
            context: globalContext,
            property,
            mode: 'replace',
            expected_head: listing.adoption?.head ?? null,
            selection: live.map((candidate) => ({ candidate: candidate.id, rank: 'normal' })),
          });
          expect(adopted.status).toBe(200);
          return;
        }
        const accepted = await editor.http(`/v1/subjects/${subject}/candidates/${next.id}:accept`, {
          context: globalContext,
          expected_head: next.head,
        });
        expect(accepted.status).toBe(200);
        seen.add(next.id);
      }
    }
    async function read(subject: string) {
      const response = await editor.http(`/v1/subjects/${subject}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          id: string;
          type: string;
          statements: Record<string, { value: { content: unknown } }[]>;
        };
      };
    }

    const path = join(directory, 'state.sqlite');
    const destination = { origin: 'https://kernel.import.test' };
    const commands: BatchCommand[] = [];
    const port = {
      ...runtime.importTransport,
      async batch(request: Parameters<typeof runtime.importTransport.batch>[0]) {
        commands.push(...request.commands);
        return runtime.importTransport.batch(request);
      },
    };
    const firstPlan = await planCrossMediaSeed(tables(), { selection: developmentShowcaseSelection });
    const first = await seedCrossMedia(firstPlan, path, port, destination, { mediaDeadlineMs: 0 });
    const vnId = subjectId(first.readings.find((row) => row.source === 'vndb' && row.externalId === sourceWork)!);
    const animeId = subjectId(first.readings.find((row) => row.source === 'bangumi' && row.externalId === animeWork)!);
    expect(vnId).not.toBe(animeId);
    expect(first.workLinks).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({
          provider: 'vndb',
          externalId: sourceWork,
          subject: expect.objectContaining({ subjectId: vnId }),
        }),
        sourceLink: { id: 1, site: 'website', value: linkedUrl },
        reference: expect.objectContaining({
          status: 'current',
          provider: 'bangumi',
          externalId: animeWork,
          subject: expect.objectContaining({ subjectId: animeId }),
        }),
      }),
    );
    const handoff = first.workLinks.find((link) => link.source.externalId === sourceWork)!;
    expect(handoff.source.subject?.route.startsWith(`/subjects/${vnId}/`)).toBe(true);
    expect(handoff.reference.status).toBe('current');
    if (handoff.reference.status === 'current')
      expect(handoff.reference.subject.route.startsWith(`/subjects/${animeId}/`)).toBe(true);
    const firstCommandBodies = commands.map((command) => JSON.stringify(command));
    const reopened = await seedCrossMedia(
      await planCrossMediaSeed(tables(), { selection: developmentShowcaseSelection }),
      path,
      port,
      destination,
      { mediaDeadlineMs: 0 },
    );
    expect(commands.map((command) => JSON.stringify(command))).toEqual(firstCommandBodies);
    expect(reopened.workLinks).toEqual(first.workLinks);
    expect(subjectId(reopened.readings.find((row) => row.source === 'vndb' && row.externalId === sourceWork)!)).toBe(
      vnId,
    );

    const bridgeCandidates = await candidates(vnId, 'wdt:P5732');
    const bridge = bridgeCandidates.candidates.find((candidate) => candidate.source?.external_id === sourceWork)!;
    expect(bridge).toMatchObject({
      statement: { value: { content: animeWork } },
      source: {
        source: crossMediaAliases.vndb,
        external_id: sourceWork,
        record_revision: '7',
        converter_revision: 'vndb-work-links@1',
      },
    });
    expect(bridge.source?.digest).toBe(first.workLinks[0]?.candidateDigest);
    expect(
      bridge.statement.references?.some((reference) =>
        reference.parts.some((part) => part.property.id === 'schema:url' && part.value.content === linkedUrl),
      ),
    ).toBe(true);
    const urlCandidates = await candidates(vnId, 'schema:url');
    const urlCandidate = urlCandidates.candidates.find((candidate) => candidate.statement.value.content === linkedUrl)!;
    expect(
      urlCandidate.statement.references?.some((reference) =>
        reference.parts.some(
          (part) => part.property.id === 'schema:url' && part.value.content === 'https://vndb.org/v410.7',
        ),
      ),
    ).toBe(true);
    await acceptAdopt(vnId, 'wdt:P5732');
    await acceptAdopt(vnId, 'wdt:P3180');
    await acceptAdopt(vnId, 'schema:url');
    await acceptAdopt(animeId, 'wdt:P5732');

    const currentVn = await read(vnId);
    const currentAnime = await read(animeId);
    expect(currentVn.subject.id).not.toBe(currentAnime.subject.id);
    expect(currentVn.subject.type).not.toBe(currentAnime.subject.type);
    expect(currentVn.subject.statements['wdt:P5732']?.map((item) => item.value.content)).toContain(animeWork);
    expect(currentVn.subject.statements['wdt:P3180']?.map((item) => item.value.content)).toContain(sourceWork);
    expect(currentVn.subject.statements['schema:url']?.map((item) => item.value.content)).toContain(linkedUrl);
    expect(currentAnime.subject.statements['wdt:P5732']?.map((item) => item.value.content)).toContain(animeWork);

    const taken = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: sourceWork,
      fieldGroup: 'facts',
      reason: 'Selected source work link fence',
    });
    expect(taken.status).toBe(200);
    const commandOffset = commands.length;
    const refreshedPlan = await planCrossMediaSeed(tables('https://bgm.tv/subject/101'), {
      selection: developmentShowcaseSelection,
    });
    expect(refreshedPlan.records.vndb.find((record) => record.key === sourceWork)?.revision).toBe('7');
    const refreshed = await seedCrossMedia(refreshedPlan, path, port, destination, {
      mediaDeadlineMs: 0,
    });
    expect(commands.slice(commandOffset).filter((command) => command.op === 'create')).toEqual([]);
    const refreshedVnId = subjectId(
      refreshed.readings.find((row) => row.source === 'vndb' && row.externalId === sourceWork)!,
    );
    expect(refreshedVnId).toBe(vnId);
    expect(refreshed.unresolved).toContainEqual(
      expect.objectContaining({ holder: sourceWork, property: 'wdt:P5732', reason: 'fenced_source_facts' }),
    );
    expect(refreshed.workLinks[0]?.candidateDigest).not.toBe(first.workLinks[0]?.candidateDigest);
    const afterFence = await read(vnId);
    expect(afterFence.subject.statements['wdt:P5732']?.map((item) => item.value.content)).toContain('100');
    expect(afterFence.subject.statements['schema:url']?.map((item) => item.value.content)).toContain(linkedUrl);
    expect(afterFence.subject.statements['schema:url']?.map((item) => item.value.content)).not.toContain(
      'https://bgm.tv/subject/101',
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
