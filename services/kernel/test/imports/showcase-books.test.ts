import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import {
  importShowcaseBooks,
  showcaseBookFamily,
  showcaseBooksToCrossMediaPlan,
} from '../../../importer/src/showcase-books.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const origin = 'https://kernel.import.test';
const series = {
  id: 499,
  type: 1,
  name: '文学少女',
  name_cn: '文学少女',
  platform: 1002,
  series: true,
  date: '2006-04-28',
  infobox: '{{Infobox animanga/Novel\r\n|作者= 野村美月\r\n|册数= 8+8(番外)\r\n}}',
};
const volume = {
  id: 26,
  type: 1,
  name: '“文学少女”と死にたがりの道化',
  platform: 1002,
  series: false,
  date: '2006-04-28',
  infobox: '{{Infobox animanga/Novel\r\n|ISBN= 9784757728066\r\n|出版社= エンターブレイン\r\n|页数= 254\r\n}}',
};
const second = {
  id: 27,
  type: 1,
  name: '“文学少女”と飢え渇く幽霊',
  platform: 1002,
  series: false,
  date: '2006-08-30',
  infobox: '{{Infobox animanga/Novel\r\n|ISBN= 9784757729155\r\n}}',
};
const unrelated = { id: 9001, type: 1, name: '文学少女', platform: 1002, series: false };
const manga = { id: 9003, type: 1, name: '文学少女', platform: 1001, series: true };
const author = { id: 6023, name: '野村美月', type: 1 };

function tables() {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [series, volume, second, unrelated, manga],
    'bangumi/subject-relations': [
      { subject_id: 26, related_subject_id: 499, relation_type: 1002, order: 0 },
      { subject_id: 499, related_subject_id: 26, relation_type: 1003, order: 0 },
      { subject_id: 27, related_subject_id: 499, relation_type: 1002, order: 0 },
      { subject_id: 499, related_subject_id: 9002, relation_type: 1003, order: 9 },
    ],
    'bangumi/subject-persons': [
      { person_id: 6023, subject_id: 499, position: 2001, appear_eps: '' },
      { person_id: 6023, subject_id: 26, position: 2001, appear_eps: '' },
    ],
    'bangumi/person': [author],
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

test('reader keeps book, volume and author identities after accept, adopt and one refresh', async () => {
  expect(createSourceRegistration('bangumi').converter_revision).toBe(converter_revision);
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-books-native-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const publicClient = createPublicBulkClient({
      origin,
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      }) as typeof fetch,
    });
    const port = captureShowcaseCommands(runtime.importTransport, journal);
    const first = await importShowcaseBooks({
      tables: tables(),
      path: join(directory, 'import.sqlite'),
      port,
      destination: { origin },
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(first.family).toEqual(showcaseBookFamily);
    expect(first.selected).toEqual({
      series: ['499'],
      volumes: ['26', '27'],
      editions: [],
      authors: ['person:6023'],
    });
    expect(first.identities['499']?.type).toBe('schema:BookSeries');
    expect(first.identities['26']?.type).toBe('schema:Book');
    expect(first.identities['person:6023']?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(first.planned.members.some((row) => row.role === 'missing' && row.key === '9002')).toBe(true);
    expect(JSON.stringify(first.selected)).not.toContain('9001');
    expect(JSON.stringify(first.selected)).not.toContain('9003');
    expect(first.creditRoles).toEqual([expect.objectContaining({ code: '2001', property: 'schema:author' })]);
    const published = await publishShowcase({
      plan: showcaseBooksToCrossMediaPlan(first.planned),
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      ...(first.creditVocabularyRequirements
        ? { vocabularyRequirements: first.creditVocabularyRequirements }
        : {}),
    });
    expect(published.published.some((row) => row.sourceKey === '499' && row.nativeType === 'schema:BookSeries')).toBe(
      true,
    );
    expect(published.published.some((row) => row.sourceKey === '26' && row.nativeType === 'schema:Book')).toBe(true);

    const seriesId = first.identities['499']!.id;
    const volumeId = first.identities['26']!.id;
    const personId = first.identities['person:6023']!.id;
    const seriesRead = await publicClient.readSubject(seriesId);
    const volumeRead = await publicClient.readSubject(volumeId);
    const personRead = await publicClient.readSubject(personId);
    expect((seriesRead.subject as { type: string }).type).toBe('schema:BookSeries');
    expect((volumeRead.subject as { type: string }).type).toBe('schema:Book');
    expect((personRead.subject as { type: string }).type).toBe('schema:Person');
    expect(JSON.stringify(volumeRead.subject)).not.toContain('9784757728066');
    const seriesSubject = seriesRead.subject as { statements?: Record<string, { value?: { content?: string } }[]> };
    const volumeSubject = volumeRead.subject as { statements?: Record<string, { value?: { content?: string } }[]> };
    expect(volumeSubject.statements?.['wdt:P179']?.some((row) => row.value?.content === seriesId)).toBe(true);
    expect(seriesSubject.statements?.['schema:author']?.some((row) => row.value?.content === personId)).toBeFalsy();
    expect(volumeSubject.statements?.['schema:author']?.some((row) => row.value?.content === personId)).toBe(true);

    const again = await importShowcaseBooks({
      tables: tables(),
      path: join(directory, 'import.sqlite'),
      port: captureShowcaseCommands(runtime.importTransport, journal),
      destination: { origin },
      journal,
      review: runtime.importTransport,
      publicClient,
      prior: published,
    });
    expect(again.identities['499']?.id).toBe(seriesId);
    expect(again.identities['26']?.id).toBe(volumeId);
    expect(again.identities['person:6023']?.id).toBe(personId);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
    await runtime.close();
  }
}, 600_000);
