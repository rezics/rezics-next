import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { createPublicBulkClient } from '../src/public-bulk-client.ts';
import { seedShowcaseVndbReleases } from '../src/selected-import.ts';
import { showcaseDigest } from '../src/showcase-contract.ts';
import type { CandidateRead } from '../src/showcase-current-reads.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
  type ShowcaseReviewPort,
} from '../src/showcase-publication.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const context = '00000000-0000-8000-8000-000000000000';
type AcceptBody = Parameters<ShowcaseReviewPort['acceptReviewedCandidate']>[2];
type Acceptance = Awaited<ReturnType<ShowcaseReviewPort['acceptReviewedCandidate']>>;
type AdoptBody = Parameters<ShowcaseReviewPort['adoptReviewedCandidates']>[1];
type Selection = { candidate: string; rank: 'normal' | 'preferred' }[];

async function recoveryFixture() {
  const temporary = join(import.meta.dir, '../../../.temp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'showcase-acceptance-recovery-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const subjectId = randomUUID();
  let nativeType = '';
  let labels: Record<string, string> = {};
  const candidates = new Map<string, CandidateRead>();
  const candidateByKey = new Map<string, string>();
  const adopted = new Map<string, { head: number; selection: Selection }>();
  const controls: {
    fenced: boolean;
    accept?: (candidate: CandidateRead, body: AcceptBody, key: string) => void | Acceptance;
  } = { fenced: false };
  const read = () =>
    ({
      subject: {
        id: subjectId,
        type: nativeType,
        labels,
        statements: Object.fromEntries(
          [...adopted].map(([property, adoption]) => [
            property,
            adoption.selection.map(({ candidate, rank }) => ({
              ...candidates.get(candidate)!.statement,
              id: candidate,
              rank,
            })),
          ]),
        ),
      },
    });
  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      if (provider !== 'vndb') return;
      if (table === 'vn_titles') {
        yield { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null };
        yield { id: 'v1', lang: 'en', official: 't', title: 'Steins;Gate', latin: null };
      }
      if (table === 'vn') yield { id: 'v1', olang: 'ja', alias: null };
      if (table === 'entry_meta') yield { id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' };
    },
  };
  const metadata = sourceRecordMetadataFixture();
  const port = {
    async batch(request: { commands: readonly BatchCommand[] }): Promise<BatchWriteResult> {
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            nativeType = command.subject.type;
            labels = command.subject.labels;
            return { key: command.key, status: 201 as const, value: { id: subjectId, revision: 1 } };
          }
          if (command.op === 'propose') {
            const id = candidateByKey.get(command.key) ?? randomUUID();
            candidateByKey.set(command.key, id);
            candidates.set(id, {
              id,
              source: command.source,
              statement: command.statement,
              head: null,
              decision: null,
            });
            if (command.statement.property.id === 'wdt:P3180') {
              candidates.get(id)!.decision = 'accepted';
              adopted.set('wdt:P3180', { head: 1, selection: [{ candidate: id, rank: 'normal' }] });
            }
            return { key: command.key, status: 201 as const, value: { candidate: id, revision: 1 } };
          }
          return { key: command.key, status: 200 as const, value: { revision: 1 } };
        }),
      };
    },
    async readReviewedSubject() {
      return read();
    },
    async fence() {
      return { fenced: controls.fenced, securityRevision: null };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async writeSourceStatistic() {
      return {};
    },
    async clearSourceStatistic() {
      return {};
    },
  } as unknown as CrossMediaPort;
  try {
    const plan = await planCrossMediaSeed(tables);
    const result = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'import.sqlite'),
      port: captureShowcaseCommands(port, journal),
      destination: { origin: 'https://fixture.test' },
      extras: { providers: ['vndb'], mediaDeadlineMs: 0 },
    });
    const names = [...candidates.values()]
      .filter((candidate) => candidate.statement.property.id === 'schema:name')
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(names).toHaveLength(2);
    const target = names[0]!;
    const sibling = names[1]!;
    for (const candidate of candidates.values())
      if (candidate !== target) candidate.decision = 'accepted';
    const editorial: Selection = [];
    const addEditorial = (rank: 'normal' | 'preferred') => {
      const id = randomUUID();
      candidates.set(id, {
        id,
        source: null,
        statement: {
          ...sibling.statement,
          value: { type: 'value', content: { language: 'en', text: `Editorial ${id}` } },
        },
        head: 1,
        decision: 'accepted',
      });
      editorial.push({ candidate: id, rank });
      const prior = adopted.get('schema:name');
      adopted.set('schema:name', { head: (prior?.head ?? 5) + 1, selection: [...editorial] });
    };
    addEditorial('normal');
    addEditorial('preferred');
    const calls: { candidateId: string; body: AcceptBody; key: string }[] = [];
    const adoptions: AdoptBody[] = [];
    const publicReads: ReturnType<typeof read>[] = [];
    const review: ShowcaseReviewPort = {
      fence: port.fence,
      readReviewedSubject: port.readReviewedSubject,
      async reviewedCandidates(id, query) {
        expect(id).toBe(subjectId);
        const adoption = adopted.get(query.property);
        const paginated = query.property === 'schema:name';
        const rows = [...candidates.values()].filter(
          (candidate) =>
            candidate.statement.property.id === query.property &&
            (!paginated || (query.cursor ? candidate.source === null : candidate.source !== null)),
        );
        return {
          candidates: rows.map((candidate) => ({
            ...candidate,
            rank: adoption?.selection.find((item) => item.candidate === candidate.id)?.rank ?? null,
          })),
          next: paginated && !query.cursor ? 'editorial' : null,
          adoption: adoption ? { mode: 'replace', head: adoption.head } : null,
        } as never;
      },
      async acceptReviewedCandidate(id, candidateId, body, key) {
        expect(id).toBe(subjectId);
        calls.push({ candidateId, body: structuredClone(body), key });
        const candidate = candidates.get(candidateId)!;
        const receipt = controls.accept?.(candidate, body, key);
        if (receipt) return receipt;
        if (body.expected_head !== candidate.head)
          throw Object.assign(new Error('Current acceptance head differs'), { status: 412 });
        candidate.decision = 'accepted';
        candidate.head = (candidate.head ?? 0) + 1;
        return {
          acceptance: { context: body.context, candidate: candidateId, decision: 'accept', head: candidate.head },
          revision: 1,
        };
      },
      async adoptReviewedCandidates(id, body) {
        expect(id).toBe(subjectId);
        expect(body.expected_head).toBe(adopted.get(body.property)?.head ?? null);
        for (const item of body.selection) {
          expect(candidates.get(item.candidate)?.decision).toBe('accepted');
          expect(item.rank === 'normal' || item.rank === 'preferred').toBe(true);
        }
        adoptions.push(structuredClone(body));
        const selection = body.selection as Selection;
        const head = (body.expected_head ?? 0) + 1;
        adopted.set(body.property, { head, selection });
        return { adoption: { ...body, head }, revision: 1 };
      },
    };
    const publicClient = createPublicBulkClient({
      origin: 'https://fixture.test',
      fetch: (async (input) => {
        expect(new URL(String(input)).pathname.split('/').at(-1)).toBe(subjectId);
        const current = read();
        publicReads.push(structuredClone(current));
        return Response.json(current);
      }) as typeof fetch,
    });
    const digest = showcaseDigest({ source: target.source, statement: target.statement });
    const action = `accept:${showcaseDigest({ identity: target.id, digest })}`;
    return {
      target,
      sibling,
      editorial,
      addEditorial,
      controls,
      candidates,
      adopted,
      calls,
      adoptions,
      publicReads,
      action,
      get journal() {
        return journal;
      },
      publish: () =>
        publishShowcase({ plan, result, aliases: crossMediaAliases, journal, review, publicClient, onProgress() {} }),
      reopen() {
        journal.close();
        journal = new ShowcaseJournal(journalPath);
      },
      async close() {
        journal.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    journal.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function expectRecovered(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  publication: Awaited<ReturnType<typeof publishShowcase>>,
) {
  expect(publication.status).toBe('published');
  expect(publication.omissions).toEqual([]);
  const selection: Selection = [
    ...fixture.editorial,
    { candidate: fixture.sibling.id, rank: 'normal' },
    { candidate: fixture.target.id, rank: 'normal' },
  ];
  selection.sort((left, right) => left.candidate.localeCompare(right.candidate));
  expect(fixture.adopted.get('schema:name')?.selection).toEqual(selection);
  const names = publication.published[0]!.assertions.filter((assertion) => assertion.property === 'schema:name');
  expect(names.map((assertion) => assertion.candidateId).sort()).toEqual([fixture.sibling.id, fixture.target.id].sort());
  for (const assertion of names) {
    expect(assertion.adoption).toEqual({
      head: fixture.adopted.get('schema:name')!.head,
      candidateId: assertion.candidateId,
      rank: 'normal',
    });
    expect(assertion.readback).toEqual({
      ...fixture.candidates.get(assertion.candidateId)!.statement,
      id: assertion.candidateId,
      rank: 'normal',
    });
  }
  expect(fixture.publicReads.at(-1)?.subject?.statements?.['schema:name']).toEqual(
    selection.map(({ candidate, rank }) => ({ ...fixture.candidates.get(candidate)!.statement, id: candidate, rank })),
  );
}

for (const status of [409, 412]) {
  test(`acceptance recovers HTTP ${status} and retains concurrent editorial selection in one invocation`, async () => {
    const fixture = await recoveryFixture();
    try {
      fixture.controls.accept = (candidate) => {
        candidate.head = 4;
        fixture.addEditorial('normal');
        delete fixture.controls.accept;
        throw Object.assign(new Error('Concurrent review'), { status });
      };
      const publication = await fixture.publish();
      expectRecovered(fixture, publication);
      expect(fixture.calls.map((call) => call.body)).toEqual([
        { context, expected_head: null },
        { context, expected_head: 4 },
      ]);
      expect(fixture.adoptions.find((body) => body.property === 'schema:name')?.expected_head).toBe(8);
      expect(fixture.journal.action(fixture.action)?.state).toBe('acknowledged');
      expect(fixture.journal.actionDecisions(fixture.action)).toEqual([
        {
          decision: 'changed-body',
          refusal: `review-http-${status}`,
          priorIdempotencyKey: fixture.calls[0]!.key,
          idempotencyKey: fixture.calls[1]!.key,
        },
      ]);
      expect(fixture.calls[1]!.key).not.toBe(fixture.calls[0]!.key);
    } finally {
      await fixture.close();
    }
  });
}

test('a known stale response waits for a different native head and recovers after close/reopen', async () => {
  const fixture = await recoveryFixture();
  try {
    fixture.controls.accept = () => {
      throw Object.assign(new Error('Head read has not caught up'), { status: 412 });
    };
    const first = await fixture.publish();
    expect(first.status).toBe('incomplete');
    expect(fixture.calls).toHaveLength(1);
    const original = fixture.journal.action(fixture.action)!;
    expect(original).toMatchObject({ state: 'refused', error_code: 'review-http-412' });
    expect(fixture.journal.actionDecisions(fixture.action)).toEqual([]);
    fixture.reopen();
    fixture.target.head = 6;
    delete fixture.controls.accept;
    expectRecovered(fixture, await fixture.publish());
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[1]!.body).toEqual({ context, expected_head: 6 });
    expect(fixture.journal.actionDecisions(fixture.action)).toEqual([
      {
        decision: 'changed-body',
        refusal: 'review-http-412',
        priorIdempotencyKey: original.idempotency_key,
        idempotencyKey: fixture.calls[1]!.key,
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test('unknown acceptance replays the sealed body/key after reopen before advancing from a known stale head', async () => {
  const fixture = await recoveryFixture();
  try {
    fixture.controls.accept = (candidate) => {
      candidate.head = 4;
      delete fixture.controls.accept;
      throw new Error('Connection lost without an acceptance response');
    };
    expect((await fixture.publish()).status).toBe('incomplete');
    const original = fixture.journal.action(fixture.action)!;
    expect(original).toMatchObject({ state: 'prepared', error_code: null });
    expect(fixture.journal.actionDecisions(fixture.action)).toEqual([]);
    fixture.reopen();
    expectRecovered(fixture, await fixture.publish());
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.calls[1]).toEqual(fixture.calls[0]);
    expect(fixture.calls[2]!.body).toEqual({ context, expected_head: 4 });
    expect(fixture.calls[2]!.key).not.toBe(original.idempotency_key);
    expect(fixture.journal.actionDecisions(fixture.action)).toEqual([
      {
        decision: 'changed-body',
        refusal: 'review-http-412',
        priorIdempotencyKey: original.idempotency_key,
        idempotencyKey: fixture.calls[2]!.key,
      },
    ]);
    expect(fixture.journal.action(fixture.action)?.state).toBe('acknowledged');
  } finally {
    await fixture.close();
  }
});

test('an accepted current candidate still settles its unknown original response before adoption', async () => {
  const fixture = await recoveryFixture();
  try {
    let receipt: Acceptance | undefined;
    fixture.controls.accept = (candidate, body) => {
      if (receipt) return receipt;
      candidate.decision = 'accepted';
      candidate.head = 1;
      receipt = {
        acceptance: { context: body.context, candidate: candidate.id, decision: 'accept', head: 1 },
        revision: 1,
      };
      throw new Error('Committed acceptance response was lost');
    };
    expect((await fixture.publish()).status).toBe('incomplete');
    expect(fixture.journal.action(fixture.action)?.state).toBe('prepared');
    // Older journals marked unknown delivery refused; current acceptance still cannot replace its seal.
    fixture.journal.refuseAction(fixture.action, 'review-unavailable');
    fixture.reopen();
    expectRecovered(fixture, await fixture.publish());
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[1]).toEqual(fixture.calls[0]);
    expect(fixture.journal.actionDecisions(fixture.action)).toEqual([]);
    expect(fixture.journal.action(fixture.action)?.state).toBe('acknowledged');
  } finally {
    await fixture.close();
  }
});

test('continuous review changes exhaust three sends and remain recoverable after reopen', async () => {
  const fixture = await recoveryFixture();
  try {
    fixture.controls.accept = (candidate) => {
      candidate.head = (candidate.head ?? 0) + 1;
      throw Object.assign(new Error('Another concurrent review'), { status: 409 });
    };
    const interrupted = await fixture.publish();
    expect(interrupted.omissions).toContainEqual({
      provider: 'vndb',
      sourceKey: 'v1',
      code: 'candidate-acceptance-recovery-bound',
    });
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.journal.action(fixture.action)).toMatchObject({ state: 'refused', error_code: 'review-http-409' });
    expect(fixture.journal.actionDecisions(fixture.action)).toHaveLength(2);
    fixture.reopen();
    delete fixture.controls.accept;
    expectRecovered(fixture, await fixture.publish());
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls[3]!.body).toEqual({ context, expected_head: 3 });
    expect(fixture.journal.actionDecisions(fixture.action)).toHaveLength(3);
  } finally {
    await fixture.close();
  }
});

for (const change of ['rejection', 'source', 'statement', 'fence'] as const) {
  test(`acceptance refresh respects a concurrent ${change} change`, async () => {
    const fixture = await recoveryFixture();
    try {
      fixture.controls.accept = (candidate) => {
        candidate.head = 4;
        if (change === 'rejection') candidate.decision = 'rejected';
        if (change === 'source') candidate.source = { ...candidate.source!, digest: 'f'.repeat(64) };
        if (change === 'statement') candidate.statement = { ...candidate.statement, references: [] };
        if (change === 'fence') fixture.controls.fenced = true;
        throw Object.assign(new Error('Concurrent boundary change'), { status: 412 });
      };
      const publication = await fixture.publish();
      expect(publication.status).toBe('incomplete');
      expect(publication.omissions).toContainEqual({
        provider: 'vndb',
        sourceKey: 'v1',
        code:
          change === 'rejection'
            ? 'candidate-currently-rejected'
            : change === 'fence'
              ? 'source-claim-withheld'
              : 'candidate-digest-changed',
      });
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.journal.action(fixture.action)?.state).toBe('refused');
      expect(fixture.journal.actionDecisions(fixture.action)).toEqual([]);
      expect(fixture.adopted.get('schema:name')?.selection).not.toContainEqual({
        candidate: fixture.target.id,
        rank: 'normal',
      });
    } finally {
      await fixture.close();
    }
  });
}

for (const status of [401, 403, 423]) {
  test(`HTTP ${status} remains terminal across reopen even when the candidate head changes`, async () => {
    const fixture = await recoveryFixture();
    try {
      fixture.controls.accept = () => {
        throw Object.assign(new Error('Acceptance authorization or lock refusal'), { status });
      };
      expect((await fixture.publish()).status).toBe('incomplete');
      const original = fixture.journal.action(fixture.action)!;
      fixture.reopen();
      fixture.target.head = 4;
      delete fixture.controls.accept;
      const publication = await fixture.publish();
      expect(publication.omissions).toContainEqual({
        provider: 'vndb',
        sourceKey: 'v1',
        code: `review-http-${status}`,
      });
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.journal.action(fixture.action)).toEqual(original);
      expect(fixture.journal.actionDecisions(fixture.action)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
}
