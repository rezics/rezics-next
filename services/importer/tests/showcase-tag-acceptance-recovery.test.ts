import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportTransportError, type ReviewedSubjectRead } from '../src/import-client.ts';
import { GLOBAL_CONTEXT } from '../src/public-bulk-client.ts';
import { showcaseDigest, type ShowcaseReviewPort } from '../src/showcase-contract.ts';
import { showcaseAdoptGenerationKey, showcaseReviewActionKey } from '../src/showcase-adoption.ts';
import { ShowcaseJournal } from '../src/showcase-journal.ts';
import {
  adoptAcceptedReviewedTagSelection,
  completeReviewedSharedTagFlow,
  reviewReviewedTagProperty,
  type ReviewedTagAdoption,
  type ReviewedTagCandidate,
} from '../src/showcase-tags.ts';
import { reviewedStatementFixture, reviewedSubjectFixture } from './transport-driver.ts';

const schemeId = '00000000-0000-4000-8000-000000000010';
const conceptId = '00000000-0000-4000-8000-000000000011';
const workId = '00000000-0000-4000-8000-000000000012';
const schemeCandidateId = '00000000-0000-4000-8000-000000000020';
const conceptCandidateId = '00000000-0000-4000-8000-000000000021';
const workCandidateId = '00000000-0000-4000-8000-000000000022';
const editorialId = '00000000-0000-4000-8000-000000000023';
const freshId = '00000000-0000-4000-8000-000000000024';
type AcceptBody = Parameters<ShowcaseReviewPort['acceptReviewedCandidate']>[2];
type AdoptBody = AcceptBody & {
  property: string;
  mode: 'replace';
  selection: ReviewedTagAdoption['selection'];
};
type NativeCandidate = { -readonly [Key in keyof ReviewedTagCandidate]: ReviewedTagCandidate[Key] } & {
  statement: object;
};
type NativeProperty = { candidates: NativeCandidate[]; adoption: ReviewedTagAdoption | null };

function acceptanceAction(subjectId: string, candidate: string) {
  return showcaseReviewActionKey('accept', candidate, showcaseDigest({ subjectId, candidate }));
}

function acceptanceReview(target: 'scheme' | 'concept') {
  const candidate = (id: string, externalId: string): NativeCandidate => ({
    id,
    decision: 'accepted',
    retracted: null,
    head: 1,
    rank: 'normal',
    source: { source: 'vndb', external_id: externalId },
    statement: {},
  });
  const adoptedProperty = (row: NativeCandidate): NativeProperty => ({
    candidates: [row],
    adoption: { mode: 'replace', head: 1, selection: [{ candidate: row.id, rank: 'normal' }] },
  });
  const scheme = adoptedProperty(candidate(schemeCandidateId, 'tag-scheme:cont'));
  const concept = adoptedProperty(candidate(conceptCandidateId, 'g311'));
  const work = adoptedProperty(candidate(workCandidateId, 'v410'));
  const properties = new Map([
    [`${schemeId}:schema:url`, scheme],
    [`${conceptId}:skos:inScheme`, concept],
    [`${workId}:schema:genre`, work],
  ]);
  const subjectId = target === 'scheme' ? schemeId : conceptId;
  const property = target === 'scheme' ? 'schema:url' : 'skos:inScheme';
  const current = target === 'scheme' ? scheme : concept;
  const original = current.candidates[0]!;
  original.decision = null;
  original.rank = null;
  const editorial = candidate(editorialId, 'editorial-note');
  editorial.source = { source: 'editorial', external_id: 'editorial-note' };
  editorial.rank = 'preferred';
  current.candidates.unshift(editorial);
  current.adoption = { mode: 'replace', head: 4, selection: [{ candidate: editorialId, rank: 'preferred' }] };

  const acceptCalls: { candidate: string; body: AcceptBody; key: string }[] = [];
  const adoptCalls: { body: AdoptBody; key: string }[] = [];
  const acceptanceReceipts = new Map<string, { candidate: string; head: number }>();
  const adoptionReceipts = new Map<string, ReviewedTagAdoption>();
  let loseAcceptance = true;
  let acceptFailure: Error | null = null;
  let beforeAdopt: (() => void) | undefined;
  const selectedStatements = (state: NativeProperty, id: string, property: string, content: string) => {
    const selection = state.adoption?.selection.find((item) => item.candidate === id);
    return selection
      ? [reviewedStatementFixture(id, selection.rank, {
          property: { id: property },
          value: { type: 'value', content },
          references: [],
        })]
      : [];
  };
  const review = {
    async reviewedCandidates(id: string, query: { property: string }) {
      const state = properties.get(`${id}:${query.property}`);
      return {
        candidates: (state?.candidates ?? []).map((row) => ({
          ...row,
          rank: state?.adoption?.selection.find((item) => item.candidate === row.id)?.rank ?? row.rank,
        })),
        next: null,
        adoption: state?.adoption ? { mode: state.adoption.mode, head: state.adoption.head } : null,
      };
    },
    async acceptReviewedCandidate(id: string, candidateId: string, body: AcceptBody, key: string) {
      expect(id).toBe(subjectId);
      acceptCalls.push({ candidate: candidateId, body, key });
      if (acceptFailure) {
        const error = acceptFailure;
        acceptFailure = null;
        throw error;
      }
      // Native idempotency returns the old receipt without changing today's verdict or head.
      const recovered = acceptanceReceipts.get(key);
      if (recovered) return recovered;
      const row = current.candidates.find((item) => item.id === candidateId)!;
      if (body.expected_head !== row.head) throw new ImportTransportError(409);
      row.decision = 'accepted';
      row.head = (row.head ?? 0) + 1;
      const receipt = { candidate: candidateId, head: row.head };
      acceptanceReceipts.set(key, receipt);
      if (loseAcceptance) {
        loseAcceptance = false;
        throw new Error('Lost committed acceptance');
      }
      return receipt;
    },
    async adoptReviewedCandidates(id: string, body: AdoptBody, key: string) {
      beforeAdopt?.();
      adoptCalls.push({ body, key });
      const state = properties.get(`${id}:${body.property}`)!;
      const recovered = adoptionReceipts.get(key);
      if (recovered) return { adoption: { ...body, ...recovered } };
      if (body.expected_head !== (state.adoption?.head ?? null)) throw new ImportTransportError(412);
      state.adoption = { mode: body.mode, head: (state.adoption?.head ?? 0) + 1, selection: body.selection };
      adoptionReceipts.set(key, state.adoption);
      return { adoption: { ...body, ...state.adoption } };
    },
    async readReviewedSubject(id: string) {
      const subjects: Record<string, Pick<ReviewedSubjectRead['subject'], 'id' | 'type' | 'statements'>> = {
        [schemeId]: { id: schemeId, type: 'skos:ConceptScheme', statements: {} },
        [conceptId]: {
          id: conceptId,
          type: 'skos:Concept',
          statements: { 'skos:inScheme': selectedStatements(concept, conceptCandidateId, 'skos:inScheme', schemeId) },
        },
        [workId]: {
          id: workId,
          type: 'schema:VideoGame',
          statements: { 'schema:genre': selectedStatements(work, workCandidateId, 'schema:genre', conceptId) },
        },
      };
      const subject = subjects[id];
      if (!subject) throw new Error('Unexpected reviewed-tag subject');
      return reviewedSubjectFixture({ ...subject, context: GLOBAL_CONTEXT, labels: {} });
    },
  };
  return {
    review: review as unknown as ShowcaseReviewPort,
    subjectId,
    property,
    candidateId: original.id,
    acceptCalls,
    adoptCalls,
    original,
    advanceHead() {
      original.head = 9;
    },
    addPending() {
      const row = candidate(freshId, 'g12');
      row.decision = null;
      row.rank = null;
      current.candidates.unshift(row);
    },
    rejectCurrent() {
      original.decision = 'rejected';
      original.rank = 'deprecated';
      original.head = 9;
      current.adoption = { mode: 'replace', head: 12, selection: [{ candidate: editorialId, rank: 'preferred' }] };
    },
    failNextAcceptance(error: Error) {
      acceptFailure = error;
    },
    beforeAdopt(check: () => void) {
      beforeAdopt = check;
    },
  };
}

for (const target of ['scheme', 'concept'] as const) {
  test(`unknown ${target} acceptance replays its exact sealed request before fresh acceptance and current adoption`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `tag-${target}-acceptance-`));
    const path = join(directory, 'showcase.sqlite');
    let journal = new ShowcaseJournal(path);
    const native = acceptanceReview(target);
    const input = { review: native.review, schemes: [schemeId], concepts: [conceptId], works: [workId] };
    const action = acceptanceAction(native.subjectId, native.candidateId);
    try {
      await expect(completeReviewedSharedTagFlow({ ...input, journal })).rejects.toThrow('Lost committed acceptance');
      const sealed = journal.action(action)!;
      expect(sealed.state).toBe('prepared');
      expect(native.original.decision).toBe('accepted');
      expect(native.adoptCalls).toHaveLength(0);
      native.advanceHead();
      native.addPending();
      journal.close();
      journal = new ShowcaseJournal(path);
      native.beforeAdopt(() => expect(journal.action(action)?.state).toBe('acknowledged'));

      const recovered = await completeReviewedSharedTagFlow({ ...input, journal });
      expect(native.acceptCalls.map((call) => call.candidate)).toEqual([
        native.candidateId,
        native.candidateId,
        freshId,
      ]);
      expect(native.acceptCalls[1]).toEqual(native.acceptCalls[0]);
      expect(native.acceptCalls[1]?.body).toEqual(JSON.parse(sealed.body_json));
      expect(native.acceptCalls[1]?.key).toBe(sealed.idempotency_key);
      expect(journal.action(action)).toEqual({ ...sealed, state: 'acknowledged' });
      expect(native.original.head).toBe(9);
      expect(native.adoptCalls).toHaveLength(1);
      expect(native.adoptCalls[0]?.body.expected_head).toBe(4);
      expect(recovered.adopted[`${native.subjectId}:${native.property}`]).toEqual({
        mode: 'replace',
        head: 5,
        selection: [
          { candidate: native.candidateId, rank: 'normal' },
          { candidate: editorialId, rank: 'preferred' },
          { candidate: freshId, rank: 'normal' },
        ],
      });
      expect(recovered.schemes[0]).toMatchObject({ currentId: schemeId, type: 'skos:ConceptScheme', available: true });
      expect(recovered.concepts[0]).toMatchObject({ currentId: conceptId, inScheme: [schemeId], available: true });
      expect(recovered.membership.find((row) => row.property === 'schema:genre')?.values).toEqual([conceptId]);
    } finally {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('a failed historical replay stays unknown, then its successful receipt preserves a newer rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-rejected-acceptance-'));
  const path = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(path);
  const native = acceptanceReview('concept');
  const input = { review: native.review, schemes: [schemeId], concepts: [conceptId], works: [workId] };
  const action = acceptanceAction(native.subjectId, native.candidateId);
  try {
    await expect(completeReviewedSharedTagFlow({ ...input, journal })).rejects.toThrow('Lost committed acceptance');
    const sealed = journal.action(action)!;
    native.rejectCurrent();
    journal.close();
    journal = new ShowcaseJournal(path);
    const unavailable = new ImportTransportError(503, undefined, 'temporarily_unavailable', true, undefined, undefined, {
      method: 'POST',
      correlationId: 'acceptance-replay-unavailable',
    });
    native.failNextAcceptance(unavailable);
    await expect(completeReviewedSharedTagFlow({ ...input, journal })).rejects.toBe(unavailable);
    expect(journal.action(action)).toEqual(sealed);
    expect(native.adoptCalls).toHaveLength(0);

    const recovered = await completeReviewedSharedTagFlow({ ...input, journal });
    expect(native.acceptCalls).toHaveLength(3);
    for (const call of native.acceptCalls) expect(call).toEqual(native.acceptCalls[0]!);
    expect(journal.action(action)).toEqual({ ...sealed, state: 'acknowledged' });
    expect(native.original).toMatchObject({ decision: 'rejected', head: 9, rank: 'deprecated' });
    expect(recovered.accepted).not.toContain(native.candidateId);
    expect(recovered.rejected).toContain(native.candidateId);
    expect(recovered.adopted[`${native.subjectId}:${native.property}`]).toEqual({
      mode: 'replace',
      head: 12,
      selection: [{ candidate: editorialId, rank: 'preferred' }],
    });
    expect(native.adoptCalls).toHaveLength(0);
    expect(recovered.concepts[0]?.inScheme).toEqual([]);
    expect(recovered.membership).toEqual([]);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an empty current selection still settles the prepared adoption before returning current state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-empty-adoption-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const body = {
    context: GLOBAL_CONTEXT,
    property: 'skos:inScheme',
    mode: 'replace' as const,
    expected_head: null,
    selection: [{ candidate: conceptCandidateId, rank: 'normal' as const }],
  };
  const action = showcaseAdoptGenerationKey(conceptId, body.property, 'current', 0);
  const reads: string[] = [];
  const review = {
    async reviewedCandidates() {
      reads.push('current');
      return { candidates: [], next: null, adoption: null };
    },
    async adoptReviewedCandidates(id: string, sealedBody: AdoptBody, key: string) {
      reads.push('replay');
      expect(id).toBe(conceptId);
      expect(sealedBody).toEqual(body);
      expect(key).toBe('original-unknown-adoption');
      return { adoption: { ...body, head: 1 } };
    },
  } as unknown as ShowcaseReviewPort;
  try {
    journal.prepareAction(action, body, 'original-unknown-adoption');
    const recovered = await adoptAcceptedReviewedTagSelection(review, conceptId, body.property, journal);
    expect(reads).toEqual(['current', 'replay', 'current']);
    expect(journal.action(action)?.state).toBe('acknowledged');
    expect(recovered).toEqual({ adoption: null, retiredCandidateIds: [], complete: true });
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a saved acceptance lock refusal remains an error before any adoption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-locked-acceptance-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const native = acceptanceReview('concept');
  const action = acceptanceAction(native.subjectId, native.candidateId);
  try {
    journal.prepareAction(action, { context: GLOBAL_CONTEXT, expected_head: 1 }, 'locked-acceptance');
    journal.refuseAction(action, 'review-http-423');
    await expect(
      reviewReviewedTagProperty(native.review, journal, native.subjectId, native.property),
    ).rejects.toMatchObject({ status: 423 });
    expect(journal.action(action)).toMatchObject({ state: 'refused', error_code: 'review-http-423' });
    expect(native.acceptCalls).toHaveLength(0);
    expect(native.adoptCalls).toHaveLength(0);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
