import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { SourceRecord } from '@rezics/conversion';
import type { ResolvedConcept, ResolvedScheme } from '@rezics/conversion/source-vocabulary';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import {
  importBangumiCreatorCredits,
  musicLiveActionStaffReason,
  type BangumiCreatorCreditPort,
} from '../src/bangumi-creator-credits.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scheme = (n: number): ResolvedScheme => ({
  taxonomy: 'bangumi.staff',
  uri: 'https://rezics.com/schemes/bangumi/staff',
  id: id(n),
  type: 'skos:ConceptScheme',
  releaseDigest: bundledDigest,
});
const concept = (code: string, schemeId: string, n: number): ResolvedConcept => ({
  taxonomy: 'bangumi.staff',
  code,
  id: id(n),
  type: 'skos:Concept',
  schemeId,
  releaseDigest: bundledDigest,
});

function authoredWork(
  id: number,
  type: 1 | 2 | 3 | 4 | 6,
  name: string,
  extra: Record<string, unknown> = {},
): SourceRecord {
  return {
    source: 'bangumi',
    key: String(id),
    revision: null,
    payload: { id, type, name, ...extra },
  };
}
function authoredPerson(id: number, name: string): SourceRecord {
  return { source: 'bangumi', key: `person:${id}`, revision: null, payload: { id, name, type: 1 } };
}
function authoredCharacter(id: number, name: string): SourceRecord {
  return { source: 'bangumi', key: `character:${id}`, revision: null, payload: { id, name } };
}

function port() {
  const subjects = new Map<
    string,
    { id: string; type: string; labels: Record<string, string>; statements: Record<string, unknown[]> }
  >();
  const receipts = new Map<string, { bytes: string; result: BatchWriteResult['results'][number] }>();
  const requests: BatchWriteRequest[] = [];
  const fencedIds = new Set<string>();
  const metadata = sourceRecordMetadataFixture();
  const transport: BangumiCreatorCreditPort = {
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence(tuple) {
      return fencedIds.has(tuple.externalId)
        ? { fenced: true, securityRevision: '1' }
        : { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(subjectId: string) {
      return { subject: subjects.get(subjectId) } as unknown as Awaited<
        ReturnType<BangumiCreatorCreditPort['readReviewedSubject']>
      >;
    },
    async batch(request: BatchWriteRequest): Promise<BatchWriteResult> {
      requests.push(structuredClone(request));
      return {
        results: request.commands.map((command) => {
          const bytes = JSON.stringify(command);
          const prior = receipts.get(command.key);
          if (prior) {
            expect(bytes).toBe(prior.bytes);
            return structuredClone(prior.result);
          }
          const result =
            command.op === 'create'
              ? {
                  key: command.key,
                  status: 201 as const,
                  value: { id: randomUUID(), revision: 1 },
                }
              : command.op === 'propose'
                ? {
                    key: command.key,
                    status: 201 as const,
                    value: { candidate: randomUUID(), revision: 1 },
                  }
                : { key: command.key, status: 200 as const, value: { revision: 1 } };
          if (command.op === 'create' && typeof command.subject === 'object' && 'id' in result.value) {
            const externalId = command.source.external_id;
            const match = /^(person|character):([1-9][0-9]*)$/u.exec(externalId);
            const property = match?.[1] === 'person' ? 'wdt:P6298' : match?.[1] === 'character' ? 'wdt:P6296' : 'wdt:P5732';
            const value = match?.[2] ?? externalId;
            subjects.set(result.value.id, {
              id: result.value.id,
              type: command.subject.type,
              labels: { en: 'authored' },
              statements: {
                [property]: [{ value: { type: 'value', content: value } }],
              },
            });
          }
          receipts.set(command.key, { bytes, result });
          return result;
        }),
      };
    },
  };
  return {
    transport,
    requests,
    fence(externalId = '12') {
      fencedIds.add(externalId);
    },
    creditCommands(): Extract<BatchCommand, { op: 'propose' }>[] {
      return requests.flatMap((request) =>
        request.commands.filter(
          (command): command is Extract<BatchCommand, { op: 'propose' }> =>
            command.op === 'propose' &&
            (command.statement.property.id === 'schema:director' || command.statement.property.id === 'wdt:P725'),
        ),
      );
    },
  };
}

function directory() {
  return mkdtempSync(join(tmpdir(), 'bangumi-creator-credits-'));
}

test('ordinary conversion without admitted role vocabulary withholds detailed credits', () => {
  const registration = createSourceRegistration('bangumi', {
    source: 'bangumi_cross_media',
    converterRevision: 'cross-media-entities@1',
  });
  const result = registration.convert(
    { external_id: '12', record_revision: null, record: { id: 12, type: 2, name: 'Authored series' } },
    { source: 'bangumi_cross_media' },
  );
  expect(
    result.proposals.some(
      (item) =>
        item.op === 'propose' &&
        (item.statement.property.id === 'schema:director' || item.statement.property.id === 'wdt:P725'),
    ),
  ).toBe(false);
  expect(result.sourceVocabularyGaps).toBeUndefined();
});

test('operator publishes authored staff and voice credits, keeps keys on reopen, and withholds honest loss', async () => {
  const root = directory();
  const world = port();
  const bindings = {
    releaseDigest: bundledDigest,
    schemes: [scheme(100)],
    concepts: [concept('2', id(100), 101), concept('1', id(100), 102)],
  };
  const work = authoredWork(12, 2, 'Authored series');
  const director = authoredPerson(101, 'Authored director');
  const performer = authoredPerson(102, 'Authored voice');
  const character = authoredCharacter(201, 'Authored character');
  try {
    const first = await importBangumiCreatorCredits({
      path: join(root, 'state.sqlite'),
      port: world.transport,
      work,
      people: [director, performer],
      characters: [character],
      staff: [{ subject_id: 12, person_id: 101, position: 2 }],
      voice: [{ subject_id: 12, person_id: 102, character_id: 201 }],
      bindings,
    });
    const credits = world.creditCommands();
    expect(first.gaps).toEqual([]);
    expect(credits).toHaveLength(2);
    const staff = credits.find((item) => item.statement.property.id === 'schema:director')!;
    expect(staff.statement.qualifiers).toEqual([
      { property: { id: 'wdt:P3831' }, value: { type: 'value', content: id(101) } },
    ]);
    const voice = credits.find((item) => item.statement.property.id === 'wdt:P725')!;
    expect(voice.statement.qualifiers?.[0]).toMatchObject({ property: { id: 'wdt:P453' } });
    expect(JSON.stringify(credits)).not.toContain('schema:position');
    const keys = first.keys.slice().sort();
    const reopen = await importBangumiCreatorCredits({
      path: join(root, 'state.sqlite'),
      port: world.transport,
      work,
      people: [director, performer],
      characters: [character],
      staff: [{ subject_id: 12, person_id: 101, position: 2 }],
      voice: [{ subject_id: 12, person_id: 102, character_id: 201 }],
      bindings,
    });
    expect(reopen.keys.slice().sort()).toEqual(keys);
    const beforeChange = world.creditCommands().length;
    const changed = await importBangumiCreatorCredits({
      path: join(root, 'changed.sqlite'),
      port: world.transport,
      work,
      people: [director, performer],
      characters: [character],
      staff: [{ subject_id: 12, person_id: 101, position: 1 }],
      voice: [{ subject_id: 12, person_id: 102, character_id: 201 }],
      bindings,
    });
    expect(changed.keys).not.toEqual(keys);
    expect(world.creditCommands().length).toBeGreaterThan(beforeChange);
    const withheld = await importBangumiCreatorCredits({
      path: join(root, 'withheld.sqlite'),
      port: world.transport,
      work,
      people: [director],
      staff: [{ subject_id: 12, person_id: 101, position: 2 }],
      voice: [{ subject_id: 12, person_id: 102, character_id: 201 }],
      bindings,
    });
    expect(withheld.proposals.some((item) => item.op === 'propose' && item.statement.property.id === 'wdt:P725')).toBe(
      false,
    );
    expect(withheld.gaps.some((gap) => gap.reason === 'missing_identity' && gap.property === 'wdt:P725')).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('a facts fence withholds refresh and music staff reports the exact omitted producer binding', async () => {
  const root = directory();
  const world = port();
  const bindings = {
    releaseDigest: bundledDigest,
    schemes: [scheme(100)],
    concepts: [concept('2', id(100), 101)],
  };
  try {
    const work = authoredWork(12, 2, 'Authored series');
    const person = authoredPerson(101, 'Authored director');
    await importBangumiCreatorCredits({
      path: join(root, 'state.sqlite'),
      port: world.transport,
      work,
      people: [person],
      staff: [{ subject_id: 12, person_id: 101, position: 2 }],
      bindings,
    });
    const before = world.requests.length;
    world.fence();
    const blocked = await importBangumiCreatorCredits({
      path: join(root, 'state.sqlite'),
      port: world.transport,
      work,
      people: [person],
      staff: [{ subject_id: 12, person_id: 101, position: 2 }],
      bindings,
    });
    expect(blocked.fenced).toEqual(['12']);
    expect(blocked.proposals).toEqual([]);
    expect(world.requests.length).toBe(before);
    expect(world.creditCommands().length).toBe(1);
    const music = await importBangumiCreatorCredits({
      path: join(root, 'music.sqlite'),
      port: world.transport,
      work: authoredWork(30, 3, 'Authored album'),
      people: [authoredPerson(301, 'Authored musician')],
      staff: [{ subject_id: 30, person_id: 301, position: 3001 }],
      bindings,
    });
    expect(music.proposals).toEqual([]);
    expect(music.gaps).toMatchObject([
      {
        provider: 'bangumi',
        property: 'staff.3',
        code: '3001',
        reason: musicLiveActionStaffReason,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
