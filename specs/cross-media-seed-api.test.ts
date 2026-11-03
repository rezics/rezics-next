import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchCommand, BatchStatement } from '@rezics/definitions/bulk';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../services/importer/src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from '../services/importer/tests/transport-driver.ts';

type Persona = 'reader' | 'importer' | 'editor' | 'denied';
type Candidate = { id: string; statement: BatchStatement; accepted: boolean };
type Subject = {
  id: string;
  type: string;
  labels: Record<string, string>;
  statements: Record<string, BatchStatement[]>;
  sourceRecords: unknown[];
  revision: number;
  candidates: Candidate[];
};

function dump(): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [i, name] of ['STEINS;GATE', 'CLANNAD', 'Fate/stay night'].entries()) {
    (rows['bangumi/subject'] ??= []).push({ id: i + 1, type: 2, name });
    (rows['vndb/vn_titles'] ??= []).push({ id: `v${i + 1}`, lang: 'ja', official: 't', title: name, latin: null });
    (rows['vndb/vn'] ??= []).push({ id: `v${i + 1}`, olang: 'ja', alias: null });
    (rows['vndb/entry_meta'] ??= []).push({ id: `v${i + 1}`, revision: '1', lastmod: '2026-10-25 00:00:00+00' });
  }
  rows['bangumi/subject']!.push({ id: 4, type: 2, name: 'After Story Extra' });
  rows['bangumi/subject-relations'] = [{ subject_id: 2, related_subject_id: 4, relation_type: 3, order: 1 }];
  rows['bangumi/subject-characters'] = [{ subject_id: 1, character_id: 7, type: 1, order: 0 }];
  rows['bangumi/character'] = [{ id: 7, name: 'Okabe' }];
  rows['bangumi/subject-persons'] = [{ subject_id: 1, person_id: 8, position: 2 }];
  rows['bangumi/person'] = [{ id: 8, name: 'Director', type: 1 }];
  rows['bangumi/episode'] = [{ subject_id: 1, id: 10, sort: 1, type: 0, name: 'Prologue' }];
  rows['vndb/vn_staff'] = [{ id: 'v1', aid: '2', role: 'scenario' }];
  rows['vndb/staff_alias'] = [{ id: 's4', aid: '2', name: 'Writer' }];
  rows['vndb/staff'] = [{ id: 's4', main: '2', prod: null }];
  rows['vndb/chars_vns'] = [{ id: 'c3', vid: 'v1', role: 'main' }];
  rows['vndb/chars'] = [{ id: 'c3', main: null, name: 'Okabe' }];
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

function catalogue() {
  const subjects = new Map<string, Subject>();
  const byKey = new Map<string, string>();
  function read(id: string, persona: Persona) {
    if (persona === 'denied') {
      const error = new Error('Forbidden') as Error & { status: number };
      error.status = 403;
      throw error;
    }
    const subject = subjects.get(id);
    if (!subject) throw new Error('Missing subject');
    return {
      subject: {
        id: subject.id,
        type: subject.type,
        labels: subject.labels,
        revision: subject.revision,
        statements: persona === 'reader' ? subject.statements : subject.statements,
        sourceRecords: persona === 'reader' ? [] : subject.sourceRecords,
        candidates:
          persona === 'editor' || persona === 'importer'
            ? subject.candidates.map(({ id, statement, accepted }) => ({ id, statement, accepted }))
            : [],
      },
    };
  }
  const metadata = sourceRecordMetadataFixture();
  const port = (
    persona: Persona,
  ): CrossMediaPort & { accept(id: string, candidate: string): void; adopt(id: string): void } => ({
    async batch(request) {
      return {
        results: request.commands.map((command: BatchCommand) => {
          if (command.op === 'create') {
            const id = randomUUID();
            subjects.set(id, {
              id,
              type: command.subject.type,
              labels: command.subject.labels,
              statements: {},
              sourceRecords: [],
              revision: 1,
              candidates: [],
            });
            byKey.set(command.key, id);
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          if (command.op === 'propose') {
            const subject = subjects.get(command.subject);
            if (!subject)
              return {
                key: command.key,
                status: 404 as const,
                problem: { type: 'about:blank', title: 'missing', status: 404 },
              };
            const candidate = { id: randomUUID(), statement: command.statement, accepted: false };
            subject.candidates.push(candidate);
            subject.revision += 1;
            return {
              key: command.key,
              status: 201 as const,
              value: { candidate: candidate.id, revision: subject.revision },
            };
          }
          return { key: command.key, status: 200 as const, value: { revision: 1 } };
        }),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return read(id, persona) as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
    accept(id, candidate) {
      if (persona === 'denied') {
        const error = new Error('Forbidden') as Error & { status: number };
        error.status = 403;
        throw error;
      }
      if (persona !== 'editor') throw new Error('Forbidden');
      const subject = subjects.get(id);
      const row = subject?.candidates.find((entry) => entry.id === candidate);
      if (!row) throw new Error('Missing candidate');
      row.accepted = true;
    },
    adopt(id) {
      if (persona !== 'editor') {
        const error = new Error('Forbidden') as Error & { status: number };
        error.status = 403;
        throw error;
      }
      const subject = subjects.get(id)!;
      for (const candidate of subject.candidates) {
        if (!candidate.accepted) continue;
        const property = candidate.statement.property.id;
        (subject.statements[property] ??= []).push(candidate.statement);
      }
    },
  });
  return { subjects, port, read };
}

test('ordinary reader, importer and editor see the connected seeded graph through APIs', async () => {
  await mkdir('.temp', { recursive: true });
  const dir = await mkdtemp('.temp/cross-media-api-');
  const store = catalogue();
  try {
    const plan = await planCrossMediaSeed(dump());
    const importer = store.port('importer');
    const first = await seedCrossMedia(plan, join(dir, 'state.sqlite'), importer);
    expect(first.readings.length).toBeGreaterThan(6);
    const work = first.readings.find((row) => row.externalId === '1')!;
    const sequel = first.readings.find((row) => row.externalId === '4')!;
    const character = first.readings.find((row) => row.externalId === 'character:7')!;
    const person = first.readings.find((row) => row.externalId === 'person:8')!;
    const episode = first.readings.find((row) => row.externalId === 'episode:10')!;
    const vn = first.readings.find((row) => row.externalId === 'v1')!;
    expect(work.route).toMatch(/^\/subjects\/[0-9a-f-]{36}\//);
    expect(character.subject.subject.type).toBe('wd:Q95074');
    expect(person.subject.subject.type).toBe('schema:Person');
    expect(episode.subject.subject.type).toBe('schema:Episode');
    const reader = store.read(work.subject.subject.id, 'reader');
    expect(reader.subject.statements['schema:character'] ?? []).toEqual([]);
    expect(reader.subject.statements['wdt:P155'] ?? []).toEqual([]);
    const editor = store.port('editor');
    const sequelSubject = store.subjects.get(sequel.subject.subject.id)!;
    const parent = first.readings.find((row) => row.externalId === '2')!;
    const follows = sequelSubject.candidates.find((row) => row.statement.property.id === 'wdt:P155');
    expect(follows?.statement.value).toEqual({ type: 'value', content: parent.subject.subject.id });
    const steins = store.subjects.get(work.subject.subject.id)!;
    for (const candidate of steins.candidates) editor.accept(steins.id, candidate.id);
    editor.adopt(steins.id);
    const selected = store.read(steins.id, 'reader');
    expect(selected.subject.statements['schema:character']?.[0]?.value).toEqual({
      type: 'value',
      content: character.subject.subject.id,
    });
    expect(selected.subject.statements['schema:director']?.[0]?.value).toEqual({
      type: 'value',
      content: person.subject.subject.id,
    });
    expect(() => store.port('denied').accept(steins.id, steins.candidates[0]!.id)).toThrow('Forbidden');
    const before = structuredClone(selected.subject.statements);
    const again = await seedCrossMedia(plan, join(dir, 'state.sqlite'), importer);
    expect(again.runs.bangumi?.counts.unchanged).toBeGreaterThan(0);
    expect(store.read(steins.id, 'reader').subject.statements).toEqual(before);
    expect(new Set(first.readings.map((row) => row.subject.subject.id))).toEqual(
      new Set(again.readings.map((row) => row.subject.subject.id)),
    );
    expect(vn.subject.subject.type).toBe('wd:Q689445');
    expect(Object.values(crossMediaAliases)).toContain('bangumi_cross_media');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
