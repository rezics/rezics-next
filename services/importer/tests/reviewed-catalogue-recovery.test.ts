import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchStatement, BatchWriteResult } from '@rezics/definitions/bulk';
import { ImportTransportError } from '../src/import-client.ts';
import { ImportSession } from '../src/import-session.ts';
import { reviewedCatalogueReviewAttemptBound } from '../src/reviewed-catalogue-actions.ts';
import { createReviewedCatalogueApplication } from '../src/reviewed-catalogue-application.ts';
import { reviewedCatalogueSlot, type ReviewedCataloguePort } from '../src/reviewed-catalogue-contract.ts';
import { releasedReviewedVocabulary } from '../src/reviewed-vocabulary-port.ts';
import { reviewedStatementFixture, reviewedSubjectFixture } from './transport-driver.ts';

type AcceptBody = Parameters<ReviewedCataloguePort['acceptReviewedCandidate']>[2];
type AdoptBody = Parameters<ReviewedCataloguePort['adoptReviewedCandidates']>[1];
type Acceptance = Awaited<ReturnType<ReviewedCataloguePort['acceptReviewedCandidate']>>;
type Adoption = Awaited<ReturnType<ReviewedCataloguePort['adoptReviewedCandidates']>>;
type AcceptCall = { subject: string; candidate: string; body: AcceptBody; key: string };
type AdoptCall = { subject: string; body: AdoptBody; key: string };
type Candidate = {
  id: string;
  subject: string;
  source: BatchCommand['source'] | null;
  statement: BatchStatement;
  decision: 'accepted' | 'rejected' | null;
  rank: 'normal' | 'preferred' | 'deprecated' | null;
  head: number | null;
};

function nativeStatement(candidate: Candidate) {
  return reviewedStatementFixture(candidate.id, candidate.rank ?? 'normal', candidate.statement);
}

/** The fake server commits independently of delivery and checks exact replays before current CAS heads. */
function reviewedServer() {
  const state = { fenced: false, staleStatus: 412, omitPublicFacts: false };
  const candidates = new Map<string, Candidate>();
  const subjects = new Map<
    string,
    { type: string; statements: Record<string, ReturnType<typeof nativeStatement>[]> }
  >();
  const heads = new Map<string, number>();
  const bulk = new Map<string, BatchWriteResult['results'][number]>();
  const acceptReceipts = new Map<string, { call: AcceptCall; receipt: Acceptance }>();
  const adoptReceipts = new Map<string, { call: AdoptCall; receipt: Adoption }>();
  const calls = { accept: [] as AcceptCall[], adopt: [] as AdoptCall[] };
  const events: ('accept' | 'adopt' | 'read')[] = [];
  const reads: { subject: string; property: string; cursor: string | undefined }[] = [];
  const slot = (subject: string, property: string) => `${subject}\0${property}`;
  const stale = () => new ImportTransportError(state.staleStatus, undefined, 'review_head_changed');

  const selectCurrent = (
    subject: string,
    property: string,
    selection: { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[],
  ) => {
    for (const candidate of candidates.values())
      if (
        candidate.subject === subject &&
        candidate.statement.property.id === property &&
        candidate.rank !== 'deprecated'
      )
        candidate.rank = null;
    const selected = selection.map(({ candidate: id, rank }) => {
      const candidate = candidates.get(id)!;
      expect(candidate.subject).toBe(subject);
      expect(candidate.decision).toBe('accepted');
      candidate.rank = rank;
      return nativeStatement(candidate);
    });
    subjects.get(subject)!.statements[property] = structuredClone(selected);
    const head = (heads.get(slot(subject, property)) ?? 0) + 1;
    heads.set(slot(subject, property), head);
    return head;
  };

  const port: ReviewedCataloguePort = {
    async fence() {
      return { fenced: state.fenced, securityRevision: null };
    },
    async setSourceRecordMetadata({ command }) {
      return { record: structuredClone(command.metadata), metadata_revision: 1, effect: 'filled' };
    },
    async batch({ commands }) {
      return {
        results: commands.map((command) => {
          const prior = bulk.get(command.key);
          if (prior) return structuredClone(prior);
          let receipt: BatchWriteResult['results'][number];
          if (command.op === 'create') {
            const id = randomUUID();
            subjects.set(id, { type: command.subject.type, statements: {} });
            receipt = { key: command.key, status: 201, value: { id, revision: 1 } };
          } else if (command.op === 'propose') {
            const candidate: Candidate = {
              id: randomUUID(),
              subject: command.subject,
              source: structuredClone(command.source),
              statement: structuredClone(command.statement),
              decision: null,
              rank: null,
              head: null,
            };
            candidates.set(candidate.id, candidate);
            const rejected = randomUUID();
            candidates.set(rejected, {
              ...candidate,
              id: rejected,
              source: null,
              decision: 'rejected',
              rank: 'deprecated',
              head: 1,
            });
            receipt = { key: command.key, status: 201, value: { candidate: candidate.id, revision: 1 } };
          } else {
            throw new Error('Only the admitted create and propose commands belong to this fixture');
          }
          bulk.set(command.key, structuredClone(receipt));
          return receipt;
        }),
      };
    },
    async reviewedCandidates(subject, query) {
      events.push('read');
      reads.push({ subject, property: query.property, cursor: query.cursor });
      const rows = [...candidates.values()].filter(
        (candidate) => candidate.subject === subject && candidate.statement.property.id === query.property,
      );
      // Rejected neighbors occupy page one; fresh intent requires the complete second page.
      const continued = query.cursor === 'current-candidates';
      const visible = rows.filter((candidate) => (candidate.decision === 'rejected') !== continued);
      const head = heads.get(slot(subject, query.property));
      return {
        candidates: visible.map((candidate) => ({
          id: candidate.id,
          source: structuredClone(candidate.source),
          statement: nativeStatement(candidate),
          decision: candidate.decision,
          rank: candidate.rank,
          head: candidate.head,
          release: 'released',
          revision: 1,
          retracted: null,
          retraction: null,
        })),
        adoption: head === undefined ? null : { mode: 'replace', head },
        next: continued ? null : 'current-candidates',
      };
    },
    async acceptReviewedCandidate(subject, id, body, key) {
      events.push('accept');
      const call = { subject, candidate: id, body: structuredClone(body), key };
      calls.accept.push(call);
      const prior = acceptReceipts.get(key);
      if (prior) {
        expect(call).toEqual(prior.call);
        return structuredClone(prior.receipt);
      }
      const candidate = candidates.get(id)!;
      expect(candidate.subject).toBe(subject);
      expect(candidate.decision).not.toBe('rejected');
      if (body.expected_head !== candidate.head) throw stale();
      candidate.decision = 'accepted';
      candidate.head = (candidate.head ?? 0) + 1;
      const receipt = {
        acceptance: { context: body.context, candidate: id, decision: 'accept', head: candidate.head },
        revision: candidate.head,
      } as Acceptance;
      acceptReceipts.set(key, { call, receipt: structuredClone(receipt) });
      return receipt;
    },
    async adoptReviewedCandidates(subject, body, key) {
      events.push('adopt');
      const call = { subject, body: structuredClone(body), key };
      calls.adopt.push(call);
      const prior = adoptReceipts.get(key);
      if (prior) {
        expect(call).toEqual(prior.call);
        return structuredClone(prior.receipt);
      }
      if (body.expected_head !== (heads.get(slot(subject, body.property)) ?? null)) throw stale();
      expect(body.mode).toBe('replace');
      const head = selectCurrent(subject, body.property, body.selection);
      const receipt = { adoption: { ...structuredClone(body), head }, revision: head } as Adoption;
      adoptReceipts.set(key, { call, receipt: structuredClone(receipt) });
      return receipt;
    },
    async readReviewedSubject(id) {
      const current = subjects.get(id)!;
      return reviewedSubjectFixture({
        id,
        type: current.type,
        context: reviewedCatalogueSlot('schema:url').context,
        labels: {},
        statements: state.omitPublicFacts ? {} : current.statements,
      });
    },
  };
  return { port, state, candidates, calls, events, reads, selectCurrent, acceptReceipts, adoptReceipts };
}

type SavedAction = {
  kind: 'accept' | 'adopt';
  state: 'prepared' | 'acknowledged' | 'stale' | 'refused';
  request_json: string;
  idempotency_key: string;
  receipt_json: string | null;
  error_json: string | null;
};

function savedActions(path: string): SavedAction[] {
  const database = new Database(path, { readonly: true });
  try {
    return database
      .query<SavedAction, []>('SELECT * FROM reviewed_catalogue_action ORDER BY identity,generation')
      .all();
  } finally {
    database.close();
  }
}

async function withCatalogue(
  run: (input: {
    path: string;
    application: ReturnType<typeof createReviewedCatalogueApplication>;
    server: ReturnType<typeof reviewedServer>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'reviewed-recovery-'));
  try {
    await run({
      path: join(directory, 'state.sqlite'),
      application: createReviewedCatalogueApplication({ vocabulary: releasedReviewedVocabulary() }),
      server: reviewedServer(),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const kind of ['accept', 'adopt'] as const) {
  test(`lost ${kind} response reopens with the original persisted body and key`, () =>
    withCatalogue(async ({ path, application, server }) => {
      const lost = new ImportTransportError(undefined, undefined, 'lost-response', true);
      let interrupted = false;
      const beforeSend = (key: string, body: AcceptBody | AdoptBody) => {
        const saved = savedActions(path).find((action) => action.idempotency_key === key)!;
        expect(saved.state).toBe('prepared');
        expect(JSON.parse(saved.request_json).body).toEqual(body);
        expect(saved.receipt_json).toBeNull();
      };
      const port: ReviewedCataloguePort = {
        ...server.port,
        async acceptReviewedCandidate(subject, candidate, body, key, signal) {
          beforeSend(key, body);
          const result = await server.port.acceptReviewedCandidate(subject, candidate, body, key, signal);
          if (kind === 'accept' && !interrupted) {
            interrupted = true;
            throw lost;
          }
          return result;
        },
        async adoptReviewedCandidates(subject, body, key, signal) {
          beforeSend(key, body);
          const result = await server.port.adoptReviewedCandidates(subject, body, key, signal);
          if (kind === 'adopt' && !interrupted) {
            interrupted = true;
            throw lost;
          }
          return result;
        },
      };
      await expect(application.seed({ path, port })).rejects.toBe(lost);
      const pending = savedActions(path).filter((action) => action.state === 'prepared');
      expect(pending).toHaveLength(1);
      expect(pending[0]!.kind).toBe(kind);
      const original = server.calls[kind][0]!;
      server.events.length = 0;
      const recovered = await application.seed({ path, port });
      expect(server.events[0]).toBe(kind);
      expect(server.calls[kind][1]).toEqual(original);
      expect(JSON.stringify(server.calls[kind][1]!.body)).toBe(JSON.stringify(original.body));
      expect(server.acceptReceipts.size).toBe(recovered.facts.length);
      expect(server.adoptReceipts.size).toBe(recovered.facts.length);
      const saved = savedActions(path);
      expect(saved).toHaveLength(recovered.facts.length * 2);
      expect(saved.every((action) => action.state === 'acknowledged' && action.receipt_json !== null)).toBe(true);
      const session = new ImportSession(path);
      try {
        expect(await application.readBinding(session.bindings, port)).toEqual({
          sourceConcept: recovered.subjects['source-harem']!,
          canonicalConcept: recovered.subjects['canonical-harem']!,
        });
      } finally {
        session.close();
      }
    }));

  for (const status of [409, 412])
    test(`known ${status} during ${kind} refreshes complete current pages and preserves the selected rank`, () =>
      withCatalogue(async ({ path, application, server }) => {
        server.state.staleStatus = status;
        let raced = false;
        const port: ReviewedCataloguePort = {
          ...server.port,
          async acceptReviewedCandidate(subject, candidate, body, key, signal) {
            if (kind === 'accept' && !raced) {
              raced = true;
              const row = server.candidates.get(candidate)!;
              row.decision = 'accepted';
              row.head = 1;
            }
            return server.port.acceptReviewedCandidate(subject, candidate, body, key, signal);
          },
          async adoptReviewedCandidates(subject, body, key, signal) {
            if (kind === 'adopt' && !raced) {
              raced = true;
              server.selectCurrent(subject, body.property, [
                { candidate: body.selection[0]!.candidate, rank: 'normal' },
              ]);
            }
            return server.port.adoptReviewedCandidates(subject, body, key, signal);
          },
        };
        const result = await application.seed({ path, port });
        const [original, refreshed] = server.calls[kind];
        expect(original!.body.expected_head).toBeNull();
        expect(refreshed!.body.expected_head).toBe(1);
        expect(refreshed!.key).not.toBe(original!.key);
        if (kind === 'adopt') {
          expect(server.calls.adopt[1]!.body.selection).toEqual([
            { candidate: result.facts[0]!.candidate, rank: 'normal' },
          ]);
          expect(result.facts[0]!.adoption.adoption.selection).toEqual(server.calls.adopt[1]!.body.selection);
        }
        const failed = savedActions(path).filter((action) => action.state === 'stale');
        expect(failed).toHaveLength(1);
        expect(JSON.parse(failed[0]!.error_json!).status).toBe(status);
        expect(failed[0]!.idempotency_key).toBe(original!.key);
        expect(server.reads.filter((read) => read.cursor === 'current-candidates').length).toBeGreaterThan(0);
        expect(
          [...server.candidates.values()]
            .filter((row) => row.source === null)
            .every((row) => row.decision === 'rejected' && row.rank === 'deprecated' && row.head === 1),
        ).toBe(true);
      }));

  test(`an unrelated ${kind} success stays unresolved until an exact replay confirms it`, () =>
    withCatalogue(async ({ path, application, server }) => {
      const port: ReviewedCataloguePort = {
        ...server.port,
        async acceptReviewedCandidate(...args) {
          const receipt = await server.port.acceptReviewedCandidate(...args);
          return kind === 'accept'
            ? { ...receipt, acceptance: { ...receipt.acceptance, context: randomUUID() } }
            : receipt;
        },
        async adoptReviewedCandidates(...args) {
          const receipt = await server.port.adoptReviewedCandidates(...args);
          return kind === 'adopt'
            ? {
                ...receipt,
                adoption: {
                  ...receipt.adoption,
                  selection: [...receipt.adoption.selection, { candidate: randomUUID(), rank: 'normal' as const }],
                },
              }
            : receipt;
        },
      };
      await expect(application.seed({ path, port })).rejects.toThrow('receipt does not match its saved request');
      expect(savedActions(path).filter((action) => action.state === 'prepared')).toHaveLength(1);
      const original = server.calls[kind][0]!;
      await application.seed({ path, port: server.port });
      expect(server.calls[kind][1]).toEqual(original);
      expect(savedActions(path).every((action) => action.state === 'acknowledged')).toBe(true);
    }));

  for (const status of [401, 403, 423])
    test(`${status} during ${kind} remains a retained refusal and stops this invocation`, () =>
      withCatalogue(async ({ path, application, server }) => {
        const refusal = new ImportTransportError(status, undefined, 'review-refused');
        let calls = 0;
        const refuse = async () => {
          calls += 1;
          throw refusal;
        };
        const port: ReviewedCataloguePort = {
          ...server.port,
          ...(kind === 'accept' ? { acceptReviewedCandidate: refuse } : { adoptReviewedCandidates: refuse }),
        };
        await expect(application.seed({ path, port })).rejects.toBe(refusal);
        expect(calls).toBe(1);
        const failed = savedActions(path).filter((action) => action.state === 'refused');
        expect(failed).toHaveLength(1);
        expect(JSON.parse(failed[0]!.error_json!).status).toBe(status);
        // A later invocation can use restored permissions while keeping the original refusal in history.
        await application.seed({ path, port: server.port });
        expect(savedActions(path).filter((action) => action.state === 'refused')).toEqual(failed);
      }));
}

test('persistent review concurrency is bounded and the next invocation resumes from retained outcomes', () =>
  withCatalogue(async ({ path, application, server }) => {
    const port: ReviewedCataloguePort = {
      ...server.port,
      async acceptReviewedCandidate(subject, candidate, body, key, signal) {
        const row = server.candidates.get(candidate)!;
        row.decision = 'accepted';
        row.head = (row.head ?? 0) + 1;
        return server.port.acceptReviewedCandidate(subject, candidate, body, key, signal);
      },
    };
    await expect(application.seed({ path, port })).rejects.toMatchObject({ status: 412 });
    expect(server.calls.accept).toHaveLength(reviewedCatalogueReviewAttemptBound);
    expect(server.calls.adopt).toHaveLength(0);
    const failed = savedActions(path);
    expect(failed).toHaveLength(reviewedCatalogueReviewAttemptBound);
    expect(failed.every((action) => action.state === 'stale' && action.receipt_json === null)).toBe(true);
    expect(new Set(failed.map((action) => action.idempotency_key)).size).toBe(reviewedCatalogueReviewAttemptBound);
    const recovered = await application.seed({ path, port: server.port });
    expect(server.calls.accept[reviewedCatalogueReviewAttemptBound]!.body.expected_head).toBe(
      reviewedCatalogueReviewAttemptBound,
    );
    expect(server.adoptReceipts.size).toBe(recovered.facts.length);
    expect(savedActions(path).filter((action) => action.state === 'stale')).toEqual(failed);
  }));

test('a stale adoption followed by a lost response replays the saved normal selection after reopen', () =>
  withCatalogue(async ({ path, application, server }) => {
    const lost = new Error('The refreshed adoption response was lost');
    let attempts = 0;
    const port: ReviewedCataloguePort = {
      ...server.port,
      async adoptReviewedCandidates(subject, body, key, signal) {
        attempts += 1;
        if (attempts === 1)
          server.selectCurrent(subject, body.property, [
            { candidate: body.selection[0]!.candidate, rank: 'normal' },
          ]);
        const receipt = await server.port.adoptReviewedCandidates(subject, body, key, signal);
        if (attempts === 2) throw lost;
        return receipt;
      },
    };
    await expect(application.seed({ path, port })).rejects.toBe(lost);
    expect(savedActions(path).filter((action) => action.state === 'stale')).toHaveLength(1);
    const pending = savedActions(path).filter((action) => action.state === 'prepared');
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]!.request_json).body.selection).toEqual([
      { candidate: server.calls.adopt[1]!.body.selection[0]!.candidate, rank: 'normal' },
    ]);
    const recovered = await application.seed({ path, port: server.port });
    expect(server.calls.adopt[2]).toEqual(server.calls.adopt[1]);
    expect(recovered.facts[0]!.adoption.adoption.selection).toEqual(server.calls.adopt[1]!.body.selection);
    expect(savedActions(path).filter((action) => action.state === 'stale')).toHaveLength(1);
  }));

test('a concurrent different editorial selection is preserved after a known stale adoption', () =>
  withCatalogue(async ({ path, application, server }) => {
    let editor: string | undefined;
    const port: ReviewedCataloguePort = {
      ...server.port,
      async adoptReviewedCandidates(subject, body, key, signal) {
        const original = server.candidates.get(body.selection[0]!.candidate)!;
        editor = randomUUID();
        server.candidates.set(editor, { ...original, id: editor, source: null });
        server.selectCurrent(subject, body.property, [{ candidate: editor, rank: 'normal' }]);
        return server.port.adoptReviewedCandidates(subject, body, key, signal);
      },
    };
    await expect(application.seed({ path, port })).rejects.toThrow(
      'Existing editorial selection must not be replaced',
    );
    expect(server.calls.adopt).toHaveLength(1);
    expect(server.adoptReceipts.size).toBe(0);
    expect(server.candidates.get(editor!)!.rank).toBe('normal');
    expect(savedActions(path).filter((action) => action.state === 'stale')).toHaveLength(1);
  }));

test('a current source fence pauses an unresolved adoption without replacing its saved intent', () =>
  withCatalogue(async ({ path, application, server }) => {
    const lost = new Error('Adoption committed but its response was lost');
    const port: ReviewedCataloguePort = {
      ...server.port,
      async adoptReviewedCandidates(...args) {
        await server.port.adoptReviewedCandidates(...args);
        throw lost;
      },
    };
    await expect(application.seed({ path, port })).rejects.toBe(lost);
    const pending = savedActions(path).filter((action) => action.state === 'prepared');
    server.state.fenced = true;
    await expect(application.seed({ path, port: server.port })).rejects.toThrow('source facts are fenced');
    expect(savedActions(path).filter((action) => action.state === 'prepared')).toEqual(pending);
    expect(server.calls.adopt).toHaveLength(1);
    server.state.fenced = false;
    await application.seed({ path, port: server.port });
    expect(server.calls.adopt[1]).toEqual(server.calls.adopt[0]);
  }));

test('confirmed review receipts still require independently served current facts', () =>
  withCatalogue(async ({ path, application, server }) => {
    server.state.omitPublicFacts = true;
    await expect(application.seed({ path, port: server.port })).rejects.toThrow('current binding is invalid');
    const saved = savedActions(path);
    expect(saved.every((action) => action.state === 'acknowledged')).toBe(true);
    const counts = { accept: server.calls.accept.length, adopt: server.calls.adopt.length };
    server.state.omitPublicFacts = false;
    await application.seed({ path, port: server.port });
    expect(server.calls.accept).toHaveLength(counts.accept);
    expect(server.calls.adopt).toHaveLength(counts.adopt);
    expect(savedActions(path)).toEqual(saved);
  }));
