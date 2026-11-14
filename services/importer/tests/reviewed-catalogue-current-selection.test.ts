import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchStatement, BatchWriteResult } from '@rezics/definitions/bulk';
import { bangumiPublicTagScheme, reviewedReferenceKey, sourceDigest } from '@rezics/conversion/support';
import { ImportSession } from '../src/import-session.ts';
import { createReviewedCatalogueApplication } from '../src/reviewed-catalogue-application.ts';
import {
  reviewedCatalogueEnvelope,
  reviewedCatalogueKey,
  reviewedCatalogueSeedOwner,
  reviewedCatalogueSlot,
  reviewedCatalogueStatement,
  type ReviewedCataloguePort,
} from '../src/reviewed-catalogue-contract.ts';
import { releasedReviewedVocabulary, type ReviewedVocabularyPort } from '../src/reviewed-vocabulary-port.ts';

type Candidate = {
  id: string;
  subject: string;
  source: BatchCommand['source'] | null;
  statement: BatchStatement;
  decision: 'accepted' | 'rejected' | null;
  rank: 'normal' | 'preferred' | 'deprecated' | null;
  head: number | null;
};
type AdoptionBody = Parameters<ReviewedCataloguePort['adoptReviewedCandidates']>[1];
const continuation = 'reviewed-rejected-neighbor-next';

function nativeStatement(candidate: Candidate, rank = candidate.rank ?? 'normal') {
  return {
    ...structuredClone(candidate.statement),
    id: candidate.id,
    rank,
    qualifiers: [],
    rezics: { release: 'released', revision: 1 },
  };
}

function reviewedPort(vocabulary: ReviewedVocabularyPort, paginated: boolean) {
  const target = vocabulary.inventory.find((seed) => seed.key === 'source-harem')!;
  const targetOwner = reviewedCatalogueSeedOwner(target);
  const targetProperty = target.facts[0]!.property;
  const rejectedId = randomUUID();
  const subjects = new Map<
    string,
    { type: string; labels: unknown; statements: Record<string, ReturnType<typeof nativeStatement>[]> }
  >();
  const candidates = new Map<string, Candidate>();
  const receipts = new Map<string, BatchWriteResult['results'][number]>();
  const heads = new Map<string, number>();
  const proposals: Extract<BatchCommand, { op: 'propose' }>[] = [];
  const accepted: string[] = [];
  const adoptions: { subject: string; body: AdoptionBody }[] = [];
  const reads: { property: string; cursor?: string; signal?: AbortSignal }[] = [];
  const slot = (subject: string, property: string) => `${subject}\0${property}`;
  const port: ReviewedCataloguePort = {
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async setSourceRecordMetadata({ command }) {
      return { record: structuredClone(command.metadata), metadata_revision: 1, effect: 'filled' };
    },
    async batch({ commands }) {
      return {
        results: commands.map((command) => {
          if (command.op === 'propose') proposals.push(structuredClone(command));
          const prior = receipts.get(command.key);
          if (prior) return structuredClone(prior);
          let receipt: BatchWriteResult['results'][number];
          if (command.op === 'create') {
            const id = randomUUID();
            subjects.set(id, { type: command.subject.type, labels: command.subject.labels, statements: {} });
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
            if (
              command.source.external_id === targetOwner.external_id &&
              command.statement.property.id === targetProperty
            )
              candidates.set(rejectedId, {
                ...candidate,
                id: rejectedId,
                source: null,
                decision: 'rejected',
                rank: 'deprecated',
                head: 1,
                statement: {
                  property: { id: targetProperty },
                  value: { type: 'value', content: 'https://fixture.test/rejected-vocabulary' },
                  references: [],
                },
              });
            receipt = { key: command.key, status: 201, value: { candidate: candidate.id, revision: 1 } };
          } else {
            throw new Error('Reviewed inventory must only create subjects and propose its released facts');
          }
          receipts.set(command.key, structuredClone(receipt));
          return receipt;
        }),
      };
    },
    async reviewedCandidates(subject, query, signal) {
      reads.push({ property: query.property, cursor: query.cursor, signal });
      const rows = [...candidates.values()].filter(
        (candidate) => candidate.subject === subject && candidate.statement.property.id === query.property,
      );
      const hasRejected = rows.some((candidate) => candidate.id === rejectedId);
      const continued = query.cursor === continuation;
      const visible =
        paginated && hasRejected
          ? rows.filter((candidate) => (candidate.id === rejectedId) !== continued)
          : rows;
      const head = heads.get(slot(subject, query.property));
      return {
        candidates: visible.map((candidate) => ({
          id: candidate.id,
          source: structuredClone(candidate.source),
          statement: nativeStatement(candidate),
          decision: candidate.decision,
          rank: candidate.rank,
          head: candidate.head,
          retracted: null,
          retraction: null,
        })),
        next: paginated && hasRejected && !continued ? continuation : null,
        adoption: head === undefined ? null : { mode: 'replace', head },
      } as Awaited<ReturnType<ReviewedCataloguePort['reviewedCandidates']>>;
    },
    async acceptReviewedCandidate(subject, id, body) {
      const candidate = candidates.get(id)!;
      if (candidate.subject !== subject || candidate.decision === 'rejected')
        throw new Error('Rejected review evidence cannot be accepted');
      accepted.push(id);
      candidate.decision = 'accepted';
      candidate.head = (candidate.head ?? 0) + 1;
      return {
        acceptance: { context: body.context, candidate: id, decision: 'accept', head: candidate.head },
        revision: candidate.head,
      } as Awaited<ReturnType<ReviewedCataloguePort['acceptReviewedCandidate']>>;
    },
    async adoptReviewedCandidates(subject, body) {
      adoptions.push({ subject, body: structuredClone(body) });
      const key = slot(subject, body.property);
      const head = heads.get(key) ?? null;
      if (body.mode !== 'replace' || body.expected_head !== head) throw new Error('Unexpected fixture adoption head');
      const selected = body.selection.map(({ candidate: id, rank }) => {
        const candidate = candidates.get(id)!;
        if (candidate.subject !== subject || candidate.decision !== 'accepted')
          throw new Error('Only independently accepted candidates may be adopted');
        candidate.rank = rank;
        return nativeStatement(candidate, rank);
      });
      // Store the independently served public facts separately from candidate-page evidence.
      subjects.get(subject)!.statements[body.property] = structuredClone(selected);
      const next = (head ?? 0) + 1;
      heads.set(key, next);
      return {
        adoption: { ...structuredClone(body), head: next },
        revision: next,
      } as Awaited<ReturnType<ReviewedCataloguePort['adoptReviewedCandidates']>>;
    },
    async readReviewedSubject(id) {
      return {
        subject: { id, context: reviewedCatalogueSlot('schema:url').context, ...structuredClone(subjects.get(id)!) },
      } as Awaited<ReturnType<ReviewedCataloguePort['readReviewedSubject']>>;
    },
  };
  return { port, proposals, accepted, adoptions, reads, rejectedId, candidates };
}

for (const paginated of [false, true]) {
  const listing = paginated ? 'paginated' : 'single page';
  test(`released binding survives rejected deprecated evidence and reopen (${listing})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reviewed-current-selection-'));
    const path = join(directory, 'state.sqlite');
    const vocabulary = releasedReviewedVocabulary();
    const application = createReviewedCatalogueApplication({ vocabulary });
    const fixture = reviewedPort(vocabulary, paginated);
    const { port } = fixture;
    const signal = new AbortController().signal;
    try {
      const first = await application.seed({ path, port, signal });
      const binding = {
        sourceConcept: first.subjects['source-harem']!,
        canonicalConcept: first.subjects['canonical-harem']!,
      };
      const expected = vocabulary.inventory.flatMap((seed) =>
        seed.facts.map((fact) => ({
          op: 'propose',
          source: reviewedCatalogueEnvelope(seed, vocabulary.revision),
          subject: first.subjects[seed.key]!,
          statement: reviewedCatalogueStatement(fact, first.subjects),
          key: reviewedCatalogueKey(reviewedCatalogueSeedOwner(seed), `propose:${sourceDigest(fact)}`),
        })),
      );
      expect(first.facts).toHaveLength(expected.length);
      expect(fixture.proposals).toEqual(expected);
      for (const receipt of first.facts) {
        const read = await port.readReviewedSubject(receipt.subject, signal);
        expect(read.subject.statements[receipt.statement.property.id]).toContainEqual(
          expect.objectContaining({ ...receipt.statement, id: receipt.candidate, rank: 'preferred' }),
        );
      }

      const reopened = new ImportSession(path);
      try {
        const inspected = await application.inspect(reopened.bindings, port, signal);
        expect(inspected).toMatchObject({ state: 'bound', evidence: { binding } });
        if (inspected.state === 'bound') {
          expect(inspected.evidence.vocabulary.map((seed) => seed.key)).toEqual(
            vocabulary.inventory.map((seed) => seed.key),
          );
          expect(inspected.evidence.vocabulary.flatMap((seed) => seed.facts.map((fact) => fact.candidateId))).toEqual(
            first.facts.map((fact) => fact.candidate),
          );
        }
        expect(await application.readBinding(reopened.bindings, port, signal)).toEqual(binding);
        expect(await application.resolveCurrentReviewedBangumiTagSubjects(port, binding, signal)).toEqual({
          source: { requestedId: binding.sourceConcept, currentId: binding.sourceConcept, available: true },
          canonical: { requestedId: binding.canonicalConcept, currentId: binding.canonicalConcept, available: true },
        });
        const lookup = application.lookup(reopened.bindings, port);
        const conversion = { source: 'bangumi', normalized: { meta_tags: ['后宫'] } } as unknown as Parameters<
          typeof lookup.resolve
        >[0]['conversion'];
        expect(
          await lookup.resolve({
            owner: { source: 'bangumi', external_id: '884' },
            conversion,
            signal,
          }),
        ).toEqual({ [reviewedReferenceKey(bangumiPublicTagScheme, '后宫')]: binding.sourceConcept });
      } finally {
        reopened.close();
      }

      const second = await application.seed({ path, port, signal });
      expect(second.subjects).toEqual(first.subjects);
      expect(second.facts.map((fact) => fact.candidate)).toEqual(first.facts.map((fact) => fact.candidate));
      expect(fixture.proposals).toEqual([...expected, ...expected]);
      const receipts = [...first.facts, ...second.facts];
      expect(fixture.accepted).toEqual(receipts.map((fact) => fact.candidate));
      expect(fixture.adoptions.map(({ subject, body }) => ({ subject, selection: body.selection }))).toEqual(
        receipts.map((fact) => ({
          subject: fact.subject,
          selection: [{ candidate: fact.candidate, rank: 'preferred' }],
        })),
      );
      expect(fixture.candidates.get(fixture.rejectedId)).toMatchObject({
        decision: 'rejected',
        rank: 'deprecated',
        head: 1,
      });
      expect(fixture.reads.every((read) => read.signal === signal)).toBe(true);
      expect(fixture.reads.some((read) => read.cursor === continuation)).toBe(paginated);
      const final = new ImportSession(path);
      try {
        expect(await application.readBinding(final.bindings, port, signal)).toEqual(binding);
      } finally {
        final.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
