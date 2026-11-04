import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchStatement } from '@rezics/definitions/bulk';
import { emptyCrossMediaPlan, seedCrossMedia } from '../src/cross-media-seed.ts';
import { ImportSession } from '../src/import-session.ts';
import { seedReviewedCatalogue, type ReviewedCataloguePort } from '../src/reviewed-catalogue.ts';

const context = '00000000-0000-8000-8000-000000000000';
type Candidate = {
  id: string;
  subject: string;
  source: BatchCommand['source'];
  statement: BatchStatement;
  decision: 'proposed' | 'accepted' | 'rejected';
  rank: 'normal' | 'preferred' | null;
  retracted: number | null;
  head: number | null;
};
type Subject = { id: string; type: string; labels: Record<string, string>; statements: Record<string, unknown[]> };

function fakePort(): ReviewedCataloguePort & Parameters<typeof seedCrossMedia>[2] {
  const subjects = new Map<string, Subject>();
  const owners = new Map<string, string>();
  const candidates = new Map<string, Candidate>();
  const adoptions = new Map<string, { mode: 'replace'; head: number; selection: { candidate: string; rank: 'normal' | 'preferred' }[] }>();
  const key = (source: string, externalId: string) => `${source}\0${externalId}`;
  const adoptionKey = (id: string, property: string) => `${id}\0${property}`;
  const page = (id: string, property: string, target?: string) => {
    const adoption = adoptions.get(adoptionKey(id, property));
    return {
      candidates: [...candidates.values()]
        .filter(
          (row) =>
            row.subject === id &&
            row.statement.property.id === property &&
            (target === undefined || (row.statement.value.type === 'value' && row.statement.value.content === target)),
        )
        .map((row) => ({
          id: row.id,
          source: row.source,
          statement: row.statement,
          decision: row.decision === 'proposed' ? 'pending' : row.decision,
          rank: row.rank,
          retracted: row.retracted,
          retraction: null,
          head: row.head,
        })),
      next: null,
      adoption: adoption ?? null,
    } as never;
  };
  const port = {
    async batch(request: { commands: readonly BatchCommand[] }) {
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const ownerKey = key(command.source.source, command.source.external_id);
            let id = owners.get(ownerKey);
            const created = !id;
            if (!id) {
              id = randomUUID();
              owners.set(ownerKey, id);
              subjects.set(id, { id, type: command.subject.type, labels: command.subject.labels, statements: {} });
            }
            return { key: command.key, status: created ? 201 as const : 200 as const, value: { id, revision: 1 } };
          }
          if (command.op === 'propose') {
            const id = randomUUID();
            candidates.set(id, {
              id,
              subject: command.subject,
              source: command.source,
              statement: command.statement,
              decision: 'proposed',
              rank: null,
              retracted: null,
              head: null,
            });
            return { key: command.key, status: 201 as const, value: { candidate: id, revision: 1 } };
          }
          const old = candidates.get(command.candidate);
          if (old) old.retracted = 1;
          return { key: command.key, status: 200 as const, value: { revision: 2 } };
        }),
      };
    },
    async setSourceRecordMetadata({ command }: { command: { metadata: unknown } }) {
      return { record: command.metadata, metadata_revision: 1, effect: 'filled' } as never;
    },
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async readReviewedSubject(id: string) {
      const subject = subjects.get(id);
      if (!subject) return { missing: true } as never;
      const statements: Record<string, unknown[]> = {};
      for (const [property, adoption] of adoptions) {
        if (!property.startsWith(`${id}\0`)) continue;
        const name = property.slice(id.length + 1);
        statements[name] = adoption.selection.flatMap(({ candidate }) => {
          const row = candidates.get(candidate);
          return row && row.retracted === null ? [{ id: row.id, ...row.statement }] : [];
        });
      }
      return { subject: { ...subject, context, statements } } as never;
    },
    async reviewedCandidates(id: string, query: { property: string; target?: string }) {
      return page(id, query.property, query.target);
    },
    async acceptReviewedCandidate(id: string, candidate: string, body: { context: string }) {
      const row = candidates.get(candidate)!;
      row.decision = 'accepted';
      row.head = (row.head ?? 0) + 1;
      return { acceptance: { context: body.context, candidate, decision: 'accept', head: row.head }, revision: row.head } as never;
    },
    async adoptReviewedCandidates(id: string, body: { context: string; property: string; selection: Candidate['rank'][] }) {
      const selection = body.selection as unknown as { candidate: string; rank: 'normal' | 'preferred' }[];
      const k = adoptionKey(id, body.property);
      const current = adoptions.get(k);
      const next = { mode: 'replace' as const, head: (current?.head ?? 0) + 1, selection };
      adoptions.set(k, next);
      for (const item of selection) {
        const row = candidates.get(item.candidate);
        if (row) row.rank = item.rank;
      }
      return { adoption: { context: body.context, property: body.property, ...next }, revision: next.head } as never;
    },
    async writeSourceStatistic() {
      return {};
    },
    async clearSourceStatistic() {
      return {};
    },
  };
  return port as unknown as ReviewedCataloguePort & Parameters<typeof seedCrossMedia>[2];
}

test('default cross-media seed binds the exact editor tag and resumes unchanged facts across a current-binding outage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-genre-'));
  const statePath = join(directory, 'state.sqlite');
  const port = fakePort();
  let unavailable = false;
  const reviewedPort = {
    ...port,
    async reviewedCandidates(id: string, query: { property: string; target?: string }, signal?: AbortSignal) {
      if (unavailable) throw new TypeError('Current reviewed candidate read unavailable');
      return port.reviewedCandidates(id, query, signal);
    },
  } as ReviewedCataloguePort;
  const actualSelectedRecord = {
    id: 884,
    type: 2,
    name: 'CHAOS;HEAD',
    name_cn: '混沌头',
    meta_tags: ['科幻', '后宫', 'TV', '日本', '游戏改'],
  };
  const plan = emptyCrossMediaPlan();
  plan.records.bangumi.push({ source: 'bangumi', key: '884', revision: null, payload: actualSelectedRecord });
  plan.members.push({ source: 'bangumi', key: '884', kind: 'work', membership: 'family', franchise: 'steins-gate' });
  try {
    const reviewed = await seedReviewedCatalogue({ path: statePath, port: reviewedPort });
    const seed = () => seedCrossMedia(
      plan,
      statePath,
      port,
      { origin: 'https://fixture.test' },
      { providers: ['bangumi'], bangumiGenrePort: reviewedPort },
    );
    const first = await seed();
    console.log(JSON.stringify(first.bangumiGenrePublication));
    const firstKeyword = first.bangumiGenrePublication!.acknowledgements.find(
      (entry) => entry.command.op === 'propose' && entry.command.statement.property.id === 'schema:keywords',
    )!;
    if (firstKeyword.command.op !== 'propose') throw new Error('Expected exact keyword proposal');
    expect(firstKeyword.command.source.source).toBe('bangumi_cross_media');
    expect(firstKeyword.command.statement.value).toEqual({ type: 'value', content: reviewed.subjects['source-harem'] });
    expect(firstKeyword.command.statement.qualifiers).toEqual([
      { property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '0', unit: '1' } } },
    ]);
    const firstCandidate = firstKeyword.candidateId;
    const titleId = first.bangumiGenrePublication!.acknowledgements.find(
      (entry) => entry.command.op === 'propose' && entry.command.statement.property.id === 'schema:name',
    )!.candidateId;

    unavailable = true;
    const retry = await seed();
    expect(retry.bangumiGenrePublication!.candidateIds).toEqual([]);
    expect(retry.bangumiGenrePublication!.diagnostics).toContainEqual({
      sourceKey: '884',
      code: 'reviewed-binding-unavailable',
    });
    const reopened = new ImportSession(statePath);
    try {
      const local = reopened.bindings.candidates({ source: 'bangumi_cross_media', external_id: '884' }, 'facts', {
        limit: 100,
      });
      expect(local.map((candidate) => candidate.candidate)).toContain(firstCandidate);
      expect(local.map((candidate) => candidate.candidate)).toContain(titleId);
    } finally {
      reopened.close();
    }

    unavailable = false;
    const recovered = await seed();
    expect(recovered.bangumiGenrePublication!.candidateIds).toContain(firstCandidate);
    expect(
      recovered.bangumiGenrePublication!.acknowledgements.filter(
        (entry) => entry.command.op === 'propose' && entry.command.statement.property.id === 'schema:keywords',
      ).map((entry) => entry.candidateId),
    ).toEqual([firstCandidate]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
