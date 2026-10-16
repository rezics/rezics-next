import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { personaNames, type PersonaSessions } from '../../../support/personas.ts';
import { createRestoreFixtureTiming } from '../../../support/restore-fixture-timing.ts';

export type ClosureOriginal = { work: string; mainVersion: string; workRevision: string;
  contribution: string; publicationDecision: string; selection: string };
type Work = Pick<ClosureOriginal, 'work' | 'mainVersion' | 'workRevision'>;
type Publication = ClosureOriginal;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSessions['owner']) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

type CreditRequest = {
  ordinal: number; persona: string; caller: string | null; actingSubject: string | null;
  phase: string; method: string; path: string; body?: unknown; idempotencyKey?: string;
  elapsedMs: number; sinceStartMs: number;
  answer: { status: number; body: string; etag: string | null };
};

/** Local credit journeys use the QA artifact directory and immediate phase records.
 * Append each answer before assertions so a later refusal or killed runner keeps it. */
export function createClosureCreditEvidence(
  row: 'realm/closure-feed' | 'realm/closure-rankings',
  mode: 'regression' | 'journey',
  source: string,
) {
  const directory = process.env.REZICS_QA_ARTIFACT_DIR ?? '.temp/closure-original-credit';
  mkdirSync(directory, { recursive: true });
  const timing = createRestoreFixtureTiming({ artifactDirectory: directory });
  const file = join(directory, `closure-original-credit-${timing.fixtureId}.jsonl`);
  const started = performance.now();
  const requests: CreditRequest[] = [];
  let currentPhase = 'initialization';
  let ordinal = 0;
  const record = (value: { kind: string; [key: string]: unknown }) => {
    appendFileSync(file, `${JSON.stringify({ ...value, row, mode, source,
      runId: process.env.REZICS_QA_RUN_ID, fixtureId: timing.fixtureId,
      sinceStartMs: performance.now() - started })}\n`, { mode: 0o600 });
  };
  record({ kind: 'evidence-start', timingFile: timing.filePath });

  async function phase<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = currentPhase;
    const firstRequest = requests.length;
    currentPhase = name;
    try {
      return await timing.phase(name, operation);
    } catch (error) {
      record({ kind: 'phase-failure', phase: name,
        failure: error instanceof Error ? error.stack : String(error),
        requestOrdinals: requests.slice(firstRequest).map(request => request.ordinal) });
      throw error;
    } finally {
      currentPhase = previous;
    }
  }

  function observe(sessions: PersonaSessions) {
    record({ kind: 'personas-ready', realm: sessions.realm, personaSeconds: sessions.elapsedSeconds,
      author: sessions.owner.actingSubject, authorAccount: sessions.owner.accountId });
    for (const persona of personaNames) {
      const person = sessions[persona];
      const call = person.main;
      person.main = async (method, path, body, key, options) => {
        const idempotencyKey = key ?? (method === 'POST' ? randomUUID() : undefined);
        const at = performance.now();
        const input = { ordinal: ++ordinal, persona, caller: person.accountId,
          actingSubject: person.actingSubject, phase: currentPhase, method, path, body, idempotencyKey };
        record({ kind: 'request-start', ...input });
        try {
          const response = await call(method, path, body, idempotencyKey, options);
          const raw = await response.clone().text();
          const request = { ...input, elapsedMs: performance.now() - at,
            sinceStartMs: performance.now() - started,
            answer: { status: response.status, body: raw, etag: response.headers.get('etag') } };
          requests.push(request);
          record({ kind: 'request-answer', ...request });
          if (method === 'GET' && /\/agent-credits(?:\?|$)/.test(path) && response.status === 200) {
            record({ kind: 'credit-inventory', requestOrdinal: input.ordinal,
              phase: input.phase, persona, path, inventory: JSON.parse(raw) });
          }
          return response;
        } catch (error) {
          record({ kind: 'request-failure', ...input, elapsedMs: performance.now() - at,
            failure: error instanceof Error ? error.stack : String(error) });
          throw error;
        }
      };
    }
  }
  return { record, phase, observe, requests };
}

export async function publishClosureOriginals(sessions: PersonaSessions, publications: Publication[], phrase: string, count = 3,
  authorityValidUntil = new Date(Date.now() + 3_600_000).toISOString()) {
  const owner = sessions.owner;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Original catalogue editors', permissions: ['publication.adopt'] },
    {
      kind: 'assignment', roleId, member: owner.actingSubject, assigned: true,
      validUntil: authorityValidUntil,
    },
  ]) {
    const roles = await answer<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
    const command = {
      actingSubject: owner.actingSubject, expectedGeneration: roles.generation,
      reason: 'Adopt original fixture publications while preserving their authors', change,
    };
    const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
    await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
  }
  for (let index = 0; index < count; index++) {
    const work = await answer<Work>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${phrase} ${index}`, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work',
      actingSubject: owner.actingSubject,
    }), 201);
    // Own-work creation supplies the native author credit; consume its public inventory.
    const credits = await answer<{ items: { id: string; agent: string; role: string }[]; nextCursor: string | null }>(
      owner.main('GET', `/v1/works/${short(work.work)}/agent-credits?${acting(owner)}`),
    );
    expect(credits.nextCursor).toBeNull();
    expect(credits.items).toHaveLength(1);
    expect(credits.items[0]).toMatchObject({ agent: owner.actingSubject, role: 'author' });
    expect(credits.items[0]!.id).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
    const draft = await answer<{ contribution: string; draftRevision: string }>(
      owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en',
        body: `Original ${phrase} story ${index}: a gardener plants a seed.`,
        actingSubject: owner.actingSubject,
      }), 201,
    );
    const published = await answer<{ publicationDecision: string }>(
      owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
        rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: owner.actingSubject,
      }), 201,
    );
    const selected = {
      work: work.work, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      actingSubject: owner.actingSubject,
    };
    await answer(owner.main('POST', '/v1/publication-selections', {
      ...selected, profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer',
    }), 201);
    const adoption = await answer<{ selection: string }>(
      owner.main('POST', '/v1/publication-selections', {
        ...selected, profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion,
        selectionBasis: 'realm-manager-review',
      }), 201,
    );
    publications.push({ ...work, ...draft, ...published, selection: adoption.selection });
  }
}
