import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { personaSessions } from '../support/personas.ts';
import { grantMangaFixtureAuthority } from '../../../scripts/qa/cases/outcomes/manga/work-hub-and-edition-choice.ts';
import { classificationContextBody, classifiedStatementBody, discloseClassificationConcept, type ClassificationPost }
  from '../../../scripts/dev/seed/classified-statement.ts';
test('the first anonymous Concept read returns seven command-created original Works without waiting for readiness', async () => {
  const evidence: unknown[] = [], inventory: string[] = [];
  const begun = Date.now();
  const sessions = await personaSessions('public', { observeMain: async event => {
    evidence.push({ phase: 'preparation', ...event });
  } });
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL! });
  const file = `.temp/realm-browse-cost-first-reader-${Bun.env.REZICS_QA_RUN_ID}.json`;
  const save = () => Bun.write(file, JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'],
    { encoding: 'utf8' }).trim(), inventory, evidence }, null, 2));
  const answer = async <T,>(pending: Promise<Response>, status = 200) => {
    const response = await pending, raw = await response.text();
    expect(response.status, raw).toBe(status); return JSON.parse(raw) as T;
  };
  try {
    const owner = sessions.owner, actor = owner.actingSubject!, roleId = randomUUID();
    const root = `/v1/realms/${sessions.realm.slice(-36)}`;
    for (const change of [
      { kind: 'role', roleId, name: 'Original publishers', permissions: ['publication.adopt'] },
      { kind: 'assignment', roleId, member: actor, assigned: true,
        validUntil: new Date(Date.now() + 3_600_000).toISOString() },
    ]) {
      const roles = await answer<{ generation: string }>(owner.main('GET', `${root}/roles?actingSubject=${encodeURIComponent(actor)}`));
      const command = { actingSubject: actor, expectedGeneration: roles.generation,
        reason: 'Publish the independently counted original inventory', change };
      const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
      await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
    }
    for (const [scope, action] of [
      ['semantic:create:root', 'semantic.change'], ['classification:define:global', 'classification.proposition.define'],
      ['classification:decide:global', 'statement.decide'], ['context:create:root', 'context.create'],
    ]) await grantMangaFixtureAuthority(pool, owner, scope!, action!);
    const post: ClassificationPost = <T,>(path: string, body: unknown, _token: string, key: string) =>
      answer<T>(owner.main('POST', path, body, key), 201);
    const concept = await post<{ concept: string; definitionRevision: string }>('/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null,
      labels: [{ language: 'en', value: `First-reader format ${randomUUID()}` }], alternativeLabels: [],
      broader: [], narrower: [], actingSubject: actor,
    }, '', randomUUID());
    await discloseClassificationConcept(post, '', actor, concept.concept, randomUUID());
    const context = await post<{ context: string; semanticRevision: string }>('/v1/contexts',
      classificationContextBody(actor, [concept]), '', randomUUID());
    for (let index = 0; index < 7; index++) {
      const work = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1', title: `Independent original Book ${index} ${randomUUID()}`, language: 'en',
        semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject: actor,
      }), 201);
      const draft = await answer<{ contribution: string; draftRevision: string; author: string }>(owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en',
        body: `An original fictional drawn garden ${index}.`, actingSubject: actor,
      }), 201);
      expect(draft.author).toBe(actor);
      const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
      }), 201);
      const selection = { work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, actingSubject: actor };
      await answer(owner.main('POST', '/v1/publication-selections', { ...selection,
        profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
        selectionBasis: 'main-maintainer' }), 201);
      await answer(owner.main('POST', '/v1/publication-selections', { ...selection,
        profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: sessions.realm },
        mainVersion: work.mainVersion, selectionBasis: 'realm-manager-review' }), 201);
      const statement = await post<{ statement: string; meaningKey: string }>('/v1/statements',
        classifiedStatementBody(actor, work.mainVersion, concept.concept, context), '', randomUUID());
      await post('/v1/statement-decisions', { profile: 'statement-decision-v1',
        target: { kind: 'qualified-fact', meaningKey: statement.meaningKey, support: [statement.statement] },
        acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
      }, '', randomUUID());
      inventory.push(work.work);
    }
    // Like the Anime preparation boundary, the final ordinary write is an
    // unrelated private draft. It adds no selected Work or Concept edge.
    const privateWork = await answer<{ work: string }>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `Private unrelated draft ${randomUUID()}`, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject: actor,
    }), 201);
    evidence.push({ phase: 'preparation-end', elapsedMs: Date.now() - begun, privateWork });
    expect(Date.now() - begun).toBeLessThan(600_000);
    const path = `${root}/modules/browse?${new URLSearchParams({ concept: concept.concept, sort: 'newest',
      type: 'https://schema.org/Book', language: 'en', limit: '20' })}`;
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${Bun.env.MAIN_PORT}${path}`, { signal: AbortSignal.timeout(30_000) });
    const raw = await response.text();
    evidence.push({ phase: 'first-read', method: 'GET', path, status: response.status, answer: raw,
      elapsedMs: Date.now() - started });
    await save();
    expect(response.status, raw).toBe(200);
    const result = JSON.parse(raw) as { items: { id: string; primaryCredits: { agent: string | null; role: string }[] }[];
      matches: { value: number; kind: string }; window: { complete: boolean }; nextCursor: string | null };
    expect(result.items.map(item => item.id).sort()).toEqual([...inventory].sort());
    expect(result.items.map(item => item.id)).not.toContain(privateWork.work);
    for (const item of result.items) expect(item.primaryCredits).toContainEqual(expect.objectContaining({ agent: actor, role: 'author' }));
    expect(result.matches).toEqual({ value: 7, kind: 'exact' });
    expect(result.window.complete).toBe(true);
    expect(result.nextCursor).toBeNull();
  } finally {
    await save();
    await pool.end();
    await sessions.close();
  }
}, 300_000);
