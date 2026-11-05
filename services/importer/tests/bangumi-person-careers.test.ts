import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer } from '../src/importer.ts';
import { ImportTransportError, type ReviewedSubjectRead } from '../src/import-client.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { createBangumiPersonCareerAdmission, parseBangumiPersonCareerBindings } from '../src/bangumi-person-careers.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

test('ordinary Person refresh follows current career bindings and retains names and source identity', async () => {
  const directory = await mkdtemp(join(import.meta.dir, '../../../.temp/bangumi-person-careers-'));
  const schemeId = randomUUID(),
    conceptId = randomUUID(),
    replacementId = randomUUID(),
    subjectId = randomUUID();
  const schemeUri = 'https://rezics.com/schemes/bangumi/careers';
  const profile = {
    schemeId,
    schemeUri,
    concepts: [
      { code: 'writer', id: conceptId },
      { code: 'actor', id: replacementId },
    ],
  };
  const admission = parseBangumiPersonCareerBindings(profile);
  for (const concepts of [[...profile.concepts, profile.concepts[0]], [{ code: 'invented', id: conceptId }]])
    expect(() => parseBangumiPersonCareerBindings({ ...profile, concepts })).toThrow();
  const effects: BatchCommand[] = [];
  let visible = false;
  let unavailable = false;
  const importer = new Importer({
    path: join(directory, 'state.sqlite'),
    destination: { origin: 'https://imports.example.test' },
    vocabularyAdmission: createBangumiPersonCareerAdmission(admission, {
      async readReviewedSubject(id) {
        if (unavailable) throw new ImportTransportError(503);
        const code = id === conceptId ? 'writer' : 'actor';
        return {
          subject: {
            id,
            type: id === schemeId ? 'skos:ConceptScheme' : 'skos:Concept',
            statements: visible
              ? {
                  'schema:url': [
                    { value: { type: 'value', content: id === schemeId ? schemeUri : `${schemeUri}/${code}` } },
                  ],
                  ...(id === schemeId ? {} : { 'skos:inScheme': [{ value: { type: 'value', content: schemeId } }] }),
                }
              : {},
          },
        } as unknown as ReviewedSubjectRead;
      },
    }),
    transport: {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async batchWrite(request): Promise<BatchWriteResult> {
        effects.push(...request.commands);
        return {
          results: request.commands.map((command) => ({
            key: command.key,
            status: 200,
            value:
              command.op === 'create'
                ? { id: subjectId, revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          })),
        };
      },
    },
  });
  const registration = createSourceRegistration('bangumi');
  const run = (career: string[] | undefined) =>
    importer.runDump(
      registration,
      (async function* () {
        const payload = { id: 641, type: 1, name: 'Original', name_cn: '中文名', ...(career ? { career } : {}) };
        yield new TextEncoder().encode(
          `/type/person\tperson:641\tunversioned\t"cache-only"\t${JSON.stringify(payload)}\n`,
        );
      })(),
      { bangumiPersonDetailRows: true },
    );
  const careers = () =>
    effects.filter((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P106');
  try {
    expect((await run(['writer'])).status).toBe('committed');
    expect(careers()).toEqual([]);
    const names = effects.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:name',
    );
    visible = true;
    expect(await run(['writer'])).toMatchObject({ status: 'committed', counts: { unchanged: 1 } });
    expect(careers()).toHaveLength(1);
    expect(careers()[0]).toMatchObject({
      subject: subjectId,
      source: { external_id: 'person:641', record_revision: 'unversioned' },
      statement: { value: { type: 'value', content: conceptId } },
    });
    const before = effects.length;
    const generation = importer.session.store.source('bangumi').generation;
    unavailable = true;
    expect((await run(['writer'])).status).toBe('bulk-failed');
    expect(importer.session.store.source('bangumi').generation).toBe(generation);
    expect(effects).toHaveLength(before);
    unavailable = false;
    expect((await run(['writer'])).counts.unchanged).toBe(1);
    expect(effects).toHaveLength(before);
    expect((await run(['actor'])).counts.changed).toBe(1);
    expect(careers().at(-1)).toMatchObject({ statement: { value: { content: replacementId } } });
    expect((await run(undefined)).counts.changed).toBe(1);
    expect((await run(['writer'])).counts.changed).toBe(1);
    expect(effects.filter((command) => command.op === 'create')).toHaveLength(1);
    const currentNames = importer.session.bindings
      .candidates({ source: 'bangumi', external_id: 'person:641' }, 'facts', { limit: 100 })
      .flatMap((candidate) => (JSON.parse(candidate.bytes) as { commands: BatchCommand[] }).commands)
      .filter(
        (command): command is Extract<BatchCommand, { op: 'propose' }> =>
          command.op === 'propose' && command.statement.property.id === 'schema:name',
      );
    expect(currentNames).toHaveLength(names.length);
    expect(currentNames.map((command) => command.statement)).toEqual(
      expect.arrayContaining(names.map((command) => command.statement)),
    );
    expect(
      currentNames.every(
        (command) => command.source.digest === importer.session.store.key('bangumi', 'person:641').baseline!.digest,
      ),
    ).toBe(true);
    expect(importer.session.bindings.claim({ source: 'bangumi', external_id: 'person:641' })).toMatchObject({
      state: 'bound',
      subject: subjectId,
    });
  } finally {
    await importer.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
