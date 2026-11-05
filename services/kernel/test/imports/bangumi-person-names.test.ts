import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '../../../../packages/conversion/src/index.ts';
import { crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { createImporter } from '../../../importer/src/importer.ts';
import { createSelectedFamilySourceRegistration } from '../../../importer/src/source-registry.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const evidence = JSON.parse(
  await readFile(new URL('../../../../specs/fixtures/imports/bangumi/person-names.json', import.meta.url), 'utf8'),
) as { defaultSelection: { person: { id: number; type: number; name: string; responseBody: string } } };

test('ordinary selected-family names are separately accepted and read on the acknowledged Person', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kernel-bangumi-person-names-'));
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const importer = createImporter({
    path: join(directory, 'state.sqlite'),
    destination: { origin: 'https://kernel.import.test' },
    transport: runtime.importTransport,
  });
  try {
    const editor = await openApiObserver(runtime);
    expect(
      (
        await editor.http('/v1/grants', {
          resource: { route: 0, id: globalContext },
          subject: { kind: 'account', id: runtime.identity.governance.accountId },
          actions: ['context:accept', 'context:adopt'],
          valid: '(,)',
        })
      ).status,
    ).toBe(201);
    const person = evidence.defaultSelection.person;
    const row: SourceRecord = {
      source: 'bangumi',
      key: `person:${person.id}`,
      revision: null,
      payload: JSON.parse(person.responseBody) as Record<string, unknown>,
    };
    const registration = createSelectedFamilySourceRegistration('bangumi', crossMediaAliases.bangumi);
    const run = await importer.runRecords(
      registration,
      (async function* () {
        yield row;
      })(),
    );
    expect(run.status).toBe('committed');
    const binding = importer.session.bindings.claim({ source: crossMediaAliases.bangumi, external_id: row.key });
    expect(binding?.state).toBe('bound');
    if (binding?.state !== 'bound') throw new Error('Missing acknowledged Person binding');
    const subjectId = binding.subject;

    const query = new URLSearchParams({ property: 'schema:name', context: globalContext, limit: '100' });
    const page = await editor.http(`/v1/subjects/${subjectId}/candidates?${query}`);
    expect(page.status).toBe(200);
    const candidates = page.body.candidates as {
      id: string;
      statement: { value: { content: unknown }; references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[] };
    }[];
    expect(candidates.map(({ statement }) => statement.value.content)).toEqual([
      { language: 'und', text: '美甘義人' },
      { language: 'zh', text: '美甘义人' },
    ]);
    for (const candidate of candidates) {
      expect(candidate.statement.references?.[0]?.parts).toContainEqual({
        property: { id: 'schema:url' },
        value: { type: 'value', content: `https://bgm.tv/person/${person.id}` },
      });
      expect(
        (
          await editor.http(`/v1/subjects/${subjectId}/candidates/${candidate.id}:accept`, {
            context: globalContext,
            expected_head: null,
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await editor.http(`/v1/subjects/${subjectId}:adopt`, {
          context: globalContext,
          property: 'schema:name',
          mode: 'replace',
          selection: candidates.map(({ id }) => ({ candidate: id, rank: 'normal' })),
          expected_head: null,
        })
      ).status,
    ).toBe(200);

    const current = await editor.http(`/v1/subjects/${subjectId}?context=${globalContext}`);
    expect(current.status).toBe(200);
    const statements = (
      current.body.subject as { statements: Record<string, { value: { content: unknown }; references: unknown[] }[]> }
    ).statements['schema:name'];
    expect(statements?.map(({ value }) => value.content)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: '美甘義人' },
        { language: 'zh', text: '美甘义人' },
      ]),
    );
  } finally {
    await importer.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);
