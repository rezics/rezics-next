import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { Source } from '@rezics/definitions/bulk';
import {
  importBangumiCreatorCredits,
  musicLiveActionStaffReason,
} from '../../../importer/src/bangumi-creator-credits.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const origin = 'https://kernel.import.test';
type Candidate = {
  id: string;
  statement: {
    value: { type: string; content: unknown };
    qualifiers?: { property: { id: string }; value: { content: unknown } }[];
    rank?: 'normal' | 'preferred';
  };
  head: number | null;
};

function authoredSource(externalId: string, suffix: string): Source {
  return {
    source: 'bangumi',
    external_id: externalId,
    record_revision: `authored-${suffix}`,
    digest: 'b'.repeat(64),
    converter_revision: 'authored-fixture@1',
    field_group: 'facts',
  };
}

test('operator seed publishes detailed creator and voice credits for an independent editor', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  const root = await mkdtemp(join(tmpdir(), 'bangumi-creator-credits-'));
  try {
    const editor = await openApiObserver(runtime);
    const schemeCreated = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          source: authoredSource('900010', 'scheme'),
          key: 'authored-bangumi-staff-scheme',
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Bangumi staff' } },
        },
      ],
    });
    expect(schemeCreated.results[0]?.status).toBe(201);
    const schemeId = (schemeCreated.results[0] as { value: { id: string } }).value.id;
    const conceptCreated = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          source: authoredSource('900011', 'director'),
          key: 'authored-bangumi-staff-director',
          subject: { type: 'skos:Concept', labels: { en: 'Director' } },
        },
        {
          op: 'create',
          source: authoredSource('900012', 'author'),
          key: 'authored-bangumi-staff-author',
          subject: { type: 'skos:Concept', labels: { en: 'Author' } },
        },
      ],
    });
    expect(conceptCreated.results.map((result) => result.status)).toEqual([201, 201]);
    const directorConcept = (conceptCreated.results[0] as { value: { id: string } }).value.id;
    const authorConcept = (conceptCreated.results[1] as { value: { id: string } }).value.id;
    const bindings = {
      releaseDigest: bundledDigest,
      schemes: [
        {
          taxonomy: 'bangumi.staff',
          uri: 'https://rezics.com/schemes/bangumi/staff',
          id: schemeId,
          type: 'skos:ConceptScheme' as const,
          releaseDigest: bundledDigest,
        },
      ],
      concepts: [
        {
          taxonomy: 'bangumi.staff',
          code: '2',
          id: directorConcept,
          type: 'skos:Concept' as const,
          schemeId,
          releaseDigest: bundledDigest,
        },
        {
          taxonomy: 'bangumi.staff',
          code: '1',
          id: authorConcept,
          type: 'skos:Concept' as const,
          schemeId,
          releaseDigest: bundledDigest,
        },
      ],
    };
    const first = await importBangumiCreatorCredits({
      path: join(root, 'state.sqlite'),
      port: runtime.importTransport,
      destination: { origin },
      work: { source: 'bangumi', key: '12', revision: null, payload: { id: 12, type: 2, name: 'Authored series' } },
      people: [
        { source: 'bangumi', key: 'person:101', revision: null, payload: { id: 101, name: 'Authored director', type: 1 } },
        { source: 'bangumi', key: 'person:102', revision: null, payload: { id: 102, name: 'Authored voice', type: 1 } },
      ],
      characters: [
        { source: 'bangumi', key: 'character:201', revision: null, payload: { id: 201, name: 'Authored character' } },
      ],
      staff: [{ subject_id: 12, person_id: 101, position: 2 }],
      voice: [{ subject_id: 12, person_id: 102, character_id: 201 }],
      bindings,
    });
    expect(first.gaps).toEqual([]);
    const workId = first.identities['12']!.id;
    const personId = first.identities['person:101']!.id;
    const voiceId = first.identities['person:102']!.id;
    const characterId = first.identities['character:201']!.id;
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    async function adopt(property: string, content: string) {
      const page = await editor.http(
        `/v1/subjects/${workId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidate = listing.candidates.find((row) => row.statement.value.content === content);
      expect(candidate).toBeDefined();
      const accepted = await editor.http(`/v1/subjects/${workId}/candidates/${candidate!.id}:accept`, {
        context: globalContext,
        expected_head: candidate!.head,
      });
      expect(accepted.status).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${workId}:adopt`, {
        context: globalContext,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: [{ candidate: candidate!.id, rank: candidate!.statement.rank ?? 'normal' }],
      });
      expect(adopted.status).toBe(200);
      return candidate!;
    }

    const staffCandidate = await adopt('schema:director', personId);
    expect(staffCandidate.statement.qualifiers).toMatchObject([
      { property: { id: 'wdt:P3831' }, value: { content: directorConcept } },
    ]);
    const voiceCandidate = await adopt('wdt:P725', voiceId);
    expect(voiceCandidate.statement.qualifiers).toMatchObject([
      { property: { id: 'wdt:P453' }, value: { content: characterId } },
    ]);
    const read = await runtime.request(`/v1/subjects/${workId}?context=${globalContext}`);
    expect(read.status).toBe(200);
    const view = (await read.json()) as { subject: { statements: Record<string, { value: { content: unknown } }[]> } };
    expect(view.subject.statements['schema:director']?.map((row) => row.value.content)).toEqual([personId]);
    expect(view.subject.statements['wdt:P725']?.map((row) => row.value.content)).toEqual([voiceId]);

    const reopen = await importBangumiCreatorCredits({
      path: join(root, 'state.sqlite'),
      port: runtime.importTransport,
      destination: { origin },
      work: { source: 'bangumi', key: '12', revision: null, payload: { id: 12, type: 2, name: 'Authored series' } },
      people: [
        { source: 'bangumi', key: 'person:101', revision: null, payload: { id: 101, name: 'Authored director', type: 1 } },
        { source: 'bangumi', key: 'person:102', revision: null, payload: { id: 102, name: 'Authored voice', type: 1 } },
      ],
      characters: [
        { source: 'bangumi', key: 'character:201', revision: null, payload: { id: 201, name: 'Authored character' } },
      ],
      staff: [{ subject_id: 12, person_id: 101, position: 2 }],
      voice: [{ subject_id: 12, person_id: 102, character_id: 201 }],
      bindings,
    });
    expect(reopen.keys.slice().sort()).toEqual(first.keys.slice().sort());
    expect(reopen.identities['12']?.id).toBe(workId);

    const changed = await importBangumiCreatorCredits({
      path: join(root, 'changed.sqlite'),
      port: runtime.importTransport,
      destination: { origin },
      work: { source: 'bangumi', key: '12', revision: null, payload: { id: 12, type: 2, name: 'Authored series' } },
      people: [
        { source: 'bangumi', key: 'person:101', revision: null, payload: { id: 101, name: 'Authored director', type: 1 } },
      ],
      staff: [{ subject_id: 12, person_id: 101, position: 1 }],
      bindings,
    });
    expect(changed.keys.some((key) => first.keys.includes(key))).toBe(false);
    expect(changed.proposals.some((item) => item.op === 'propose' && item.statement.property.id === 'schema:author')).toBe(
      true,
    );

    const music = await importBangumiCreatorCredits({
      path: join(root, 'music.sqlite'),
      port: runtime.importTransport,
      destination: { origin },
      work: { source: 'bangumi', key: '30', revision: null, payload: { id: 30, type: 3, name: 'Authored album' } },
      people: [
        { source: 'bangumi', key: 'person:301', revision: null, payload: { id: 301, name: 'Authored musician', type: 1 } },
      ],
      staff: [{ subject_id: 30, person_id: 301, position: 3001 }],
      bindings,
    });
    expect(music.proposals).toEqual([]);
    expect(music.gaps).toMatchObject([{ property: 'staff.3', code: '3001', reason: musicLiveActionStaffReason }]);

    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: 'bangumi_cross_media',
      externalId: '12',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    const blocked = await importBangumiCreatorCredits({
      path: join(root, 'state.sqlite'),
      port: runtime.importTransport,
      destination: { origin },
      work: { source: 'bangumi', key: '12', revision: null, payload: { id: 12, type: 2, name: 'Authored series' } },
      people: [
        { source: 'bangumi', key: 'person:101', revision: null, payload: { id: 101, name: 'Authored director', type: 1 } },
      ],
      staff: [{ subject_id: 12, person_id: 101, position: 2 }],
      bindings,
    });
    expect(blocked.fenced).toEqual(['12']);
    expect(blocked.proposals).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await runtime.close();
  }
}, 180_000);
