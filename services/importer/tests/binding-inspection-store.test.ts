import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { MediaImportAccepted, MediaImportRequest } from '@rezics/definitions/media-import';
import { runImportCli } from '../src/cli.ts';
import { RecordBindings, type Owner } from '../src/record-bindings.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function fixture() {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'binding-inspection-'));
  const path = join(directory, 'state.sqlite');
  const database = new Database(path, { create: true, strict: true });
  const runs = new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
  const bindings = new RecordBindings(database);
  return {
    directory,
    path,
    database,
    runs,
    bindings,
    snapshot() {
      return {
        records: database.query('SELECT * FROM binding_records ORDER BY source, external_id').all(),
        journals: database.query('SELECT * FROM binding_journal ORDER BY source, external_id, key').all(),
        candidates: database.query('SELECT * FROM binding_candidates ORDER BY source, external_id, candidate').all(),
        media: database.query('SELECT * FROM binding_media ORDER BY source, external_id, key').all(),
        metadata: database.query('SELECT * FROM binding_metadata_journal ORDER BY source, external_id, key').all(),
        current: database.query('SELECT * FROM binding_metadata_current ORDER BY source, external_id').all(),
        sources: database.query('SELECT source, generation, lease_run FROM run_sources ORDER BY source').all(),
      };
    },
    close() {
      bindings.close();
      runs.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function owner(source: string, record: string): Owner {
  return { source, external_id: record };
}

function key(record: Owner, suffix: string): string {
  return `${record.source}:${record.external_id}:${suffix}`;
}

function sourceFields(record: Owner, field_group: 'facts' | 'summary' | 'cover' = 'facts') {
  return {
    source: record.source,
    external_id: record.external_id,
    record_revision: 'revision-1',
    digest: 'a'.repeat(64),
    converter_revision: 'test@1',
    field_group,
  };
}

function createRequest(record: Owner, requestKey: string): BatchWriteRequest {
  return {
    commands: [
      {
        op: 'create',
        key: requestKey,
        source: sourceFields(record),
        subject: { type: 'item', labels: { en: 'Private request body sentinel' } },
      },
    ],
  };
}

function proposeRequest(record: Owner, requestKey: string, subject: string): BatchWriteRequest {
  return {
    commands: [
      {
        op: 'propose',
        key: requestKey,
        source: sourceFields(record),
        subject,
        statement: {
          property: { id: 'schema:name' },
          value: { type: 'value', content: { language: 'en', text: 'Private candidate sentinel' } },
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:sameAs' },
                  value: { type: 'value', content: 'https://example.org/private-url' },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function createAck(requestKey: string, subject: string): BatchWriteResult {
  return { results: [{ key: requestKey, status: 201, value: { id: subject, revision: 1 } }] };
}

function proposeAck(requestKey: string, candidate: string): BatchWriteResult {
  return { results: [{ key: requestKey, status: 201, value: { candidate, revision: 1 } }] };
}

function mediaRequest(record: Owner, subject: string): MediaImportRequest {
  return {
    containerId: subject,
    sourceUrl: 'https://images.example.org/private-cover.jpg',
    credit: {
      rightsHolder: 'Private holder',
      via: { name: 'Source', url: 'https://example.org/private-via' },
      license: 'LicenseRef-unknown',
      obligations: [],
    },
    provenance: {
      source: record.source,
      external_id: record.external_id,
      record_revision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      field_group: 'cover',
      references: [
        {
          parts: [
            {
              property: { id: 'schema:sameAs' },
              value: { type: 'value', content: 'https://example.org/private-cover' },
            },
          ],
        },
      ],
    },
  };
}

function mediaAccepted(id: string, subject: string): MediaImportAccepted {
  return { media: { id, containerId: subject, purpose: 'cover', state: 'reserved' } };
}

async function inspect(path: string, args: string[]) {
  return runImportCli(['inspect-bindings', '--state', path, ...args]);
}

test('binding inspection pages original requests, distinguishes pending from acknowledged, and writes nothing', async () => {
  const state = fixture();
  try {
    const source = 'wikidata';
    const pending = owner(source, 'Q-PENDING');
    const bound = owner(source, 'Q-BOUND');
    const taken = owner(source, 'Q-TAKEN');
    const subject = uuid(1);
    const candidate = uuid(2);
    const cover = uuid(3);
    const pendingKey = key(pending, 'bootstrap');
    const boundKey = key(bound, 'bootstrap');
    const proposeKey = key(bound, 'propose');
    const takenKey = key(taken, 'bootstrap');
    const mediaKey = key(bound, 'cover');
    const metadataKey = key(bound, 'metadata');
    const signature = 'c'.repeat(64);

    const run = state.runs.begin(source);
    if (run === 'busy') throw new Error('expected a generation');
    expect(state.runs.seal(run, { complete: true }).status).toBe('ready');

    state.bindings.prepare(pending, signature, createRequest(pending, pendingKey));
    state.bindings.prepare(bound, signature, createRequest(bound, boundKey));
    state.bindings.acknowledge(bound, boundKey, createAck(boundKey, subject));
    state.bindings.prepare(bound, signature, proposeRequest(bound, proposeKey, subject));
    state.bindings.acknowledge(bound, proposeKey, proposeAck(proposeKey, candidate));
    const coverRequest = mediaRequest(bound, subject);
    state.bindings.prepareMedia(bound, mediaKey, signature, coverRequest);
    state.bindings.acceptMedia(bound, mediaKey, mediaAccepted(cover, subject));
    state.bindings.prepareMetadata(bound, metadataKey, signature, {
      source,
      external_id: bound.external_id,
      expected_metadata_revision: null,
      metadata: { name: 'Private catalogue name', url: 'https://example.org/private-metadata' },
    });
    state.bindings.acknowledgeMetadata(bound, metadataKey, {
      effect: 'filled',
      metadata_revision: 1,
      record: { name: 'Private catalogue name', url: 'https://example.org/private-metadata' },
    });
    state.bindings.prepare(taken, signature, createRequest(taken, takenKey));
    state.bindings.acknowledge(taken, takenKey, createAck(takenKey, uuid(9)));
    state.bindings.takenDown(taken, { status: 404 });

    for (let index = 0; index < 22; index++) {
      const extra = key(bound, `retired-${String(index).padStart(2, '0')}`);
      state.bindings.prepare(bound, signature, proposeRequest(bound, extra, subject));
    }

    const before = state.snapshot();
    const pendingView = await inspect(state.path, ['--source', source, '--record', pending.external_id, '--json']);
    expect(pendingView.code).toBe(0);
    expect(pendingView.openHandles).toBe(0);
    expect(pendingView.stdout).not.toContain('Private request body sentinel');
    const pendingDocument = JSON.parse(pendingView.stdout) as {
      capture: string;
      runRow: string;
      binding: { state: string; subject: string | null; bootstrapKey: string };
      sections: Record<string, string>;
    };
    expect(pendingDocument.capture).toBe('local');
    expect(pendingDocument.runRow).toBe('present');
    expect(pendingDocument.binding).toMatchObject({
      state: 'pending',
      subject: null,
      bootstrapKey: pendingKey,
    });
    expect(pendingDocument.sections.semantic).toBe('available');

    const boundView = await inspect(state.path, ['--source', source, '--record', bound.external_id, '--json']);
    const boundDocument = JSON.parse(boundView.stdout) as {
      binding: { state: string; subject: string; storedCandidateCapacity: number };
    };
    expect(boundDocument.binding).toMatchObject({ state: 'bound', subject, storedCandidateCapacity: 23 });

    const takenView = await inspect(state.path, ['--source', source, '--record', taken.external_id]);
    expect(takenView.stdout).toContain('observed native 404');
    expect(takenView.stdout).toContain('not a fresh fence');

    const absent = await inspect(state.path, ['--source', source, '--record', 'Q-ABSENT', '--json']);
    expect(JSON.parse(absent.stdout)).toMatchObject({
      binding: { state: 'absent' },
      runRow: 'present',
    });
    expect(absent.stdout).not.toMatch(/source itself is absent/i);

    const firstPage = await inspect(state.path, [
      '--source',
      source,
      '--record',
      bound.external_id,
      '--page',
      'semantic',
      '--limit',
      '20',
      '--json',
    ]);
    const page = JSON.parse(firstPage.stdout) as {
      page: {
        rows: { key: string; acknowledgement: string; body: { sha256: string; byteLength: number }; display: string }[];
        end: string;
        nextCursor: string;
        snapshot: string;
      };
    };
    expect(page.page.rows).toHaveLength(20);
    expect(page.page.end).toBe('more');
    expect(page.page.snapshot).toBe('local');
    const bootstrap = page.page.rows.find((row) => row.key === boundKey);
    expect(bootstrap).toMatchObject({ acknowledgement: 'present', display: 'retained' });
    expect(bootstrap!.body.sha256).toBe(sha256(state.bindings.journal(bound, boundKey)!.bytes));

    const secondPage = await inspect(state.path, [
      '--source',
      source,
      '--record',
      bound.external_id,
      '--page',
      'semantic',
      '--limit',
      '20',
      '--cursor',
      page.page.nextCursor,
      '--json',
    ]);
    const continued = JSON.parse(secondPage.stdout) as { page: { rows: { key: string }[]; end: string } };
    expect(continued.page.rows.length).toBeGreaterThan(0);
    expect(continued.page.end).toBe('end');
    expect(new Set([...page.page.rows, ...continued.page.rows].map((row) => row.key)).size).toBe(
      page.page.rows.length + continued.page.rows.length,
    );

    const tampered = Buffer.from(
      JSON.stringify({
        v: 1,
        source,
        record: pending.external_id,
        category: 'semantic',
        schema: 'binding-1',
        key: boundKey,
      }),
      'utf8',
    ).toString('base64url');
    const reused = await inspect(state.path, [
      '--source',
      source,
      '--record',
      bound.external_id,
      '--page',
      'semantic',
      '--cursor',
      tampered,
      '--json',
    ]);
    expect(reused.code).toBe(2);
    expect(JSON.parse(reused.stdout).error).toContain('different source, record, category or schema');

    const candidates = await inspect(state.path, [
      '--source',
      source,
      '--record',
      bound.external_id,
      '--page',
      'candidates',
      '--json',
    ]);
    const candidatePage = JSON.parse(candidates.stdout) as {
      page: { rows: { candidate: string; storedCapacityNote: string; display: string }[] };
    };
    expect(candidatePage.page.rows).toEqual([
      expect.objectContaining({
        candidate,
        display: 'retained',
        storedCapacityNote: expect.stringContaining('not a public vote'),
      }),
    ]);

    const media = await inspect(state.path, [
      '--source',
      source,
      '--record',
      bound.external_id,
      '--page',
      'media',
      '--json',
    ]);
    expect(JSON.parse(media.stdout).page.rows[0]).toMatchObject({
      mediaAccepted: 'reserved',
      mediaStatus: 'absent',
      coverPermission: 'none',
    });
    expect(media.stdout).not.toContain('private-cover.jpg');

    const metadata = await inspect(state.path, [
      '--source',
      source,
      '--record',
      bound.external_id,
      '--page',
      'metadata',
      '--request',
      metadataKey,
      '--json',
    ]);
    expect(JSON.parse(metadata.stdout).request.row).toMatchObject({
      acknowledgement: 'present',
      metadataEffect: 'filled',
    });
    expect(metadata.stdout).not.toContain('https://example.org/private-metadata');

    const unknownSource = await inspect(state.path, [
      '--source',
      'openlibrary',
      '--record',
      bound.external_id,
      '--json',
    ]);
    expect(JSON.parse(unknownSource.stdout)).toMatchObject({
      binding: { state: 'absent' },
      runRow: 'absent',
    });

    expect(state.snapshot()).toEqual(before);
  } finally {
    state.close();
  }
});

test('binding inspection reports missing files, missing tables, symlinks, corrupt rows and unsafe text', async () => {
  const state = fixture();
  try {
    const missing = join(state.directory, 'missing.sqlite');
    const missingResult = await inspect(missing, ['--source', 'wikidata', '--record', 'Q1', '--json']);
    expect(missingResult.code).toBe(2);
    expect(existsSync(missing)).toBe(false);
    expect(JSON.parse(missingResult.stdout).error).toContain('does not exist');

    const emptyPath = join(state.directory, 'runs-only.sqlite');
    const empty = new Database(emptyPath, { create: true, strict: true });
    const runs = new RunStore<SourceProjection>(empty, { projectionMode: 'source-record' });
    runs.close();
    const missingTables = await inspect(emptyPath, ['--source', 'wikidata', '--record', 'Q1', '--json']);
    expect(missingTables.code).toBe(1);
    expect(JSON.parse(missingTables.stdout).error).toContain('table binding_records is missing');

    const link = join(state.directory, 'linked.sqlite');
    symlinkSync(state.path, link);
    const refused = await inspect(link, ['--source', 'wikidata', '--record', 'Q1', '--json']);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout).error).toContain('symbolic link');

    const record = owner('wikidata', 'Q1');
    const good = key(record, 'good');
    const bad = key(record, 'bad');
    const huge = key(record, 'huge');
    const signature = 'd'.repeat(64);
    state.bindings.prepare(record, signature, createRequest(record, good));
    state.database
      .query(
        'INSERT INTO binding_journal (source, external_id, key, bytes, signature, acknowledgement) VALUES (?,?,?,?,?,?)',
      )
      .run(record.source, record.external_id, bad, '{broken', signature, null);
    state.database
      .query(
        'INSERT INTO binding_journal (source, external_id, key, bytes, signature, acknowledgement) VALUES (?,?,?,?,?,?)',
      )
      .run(record.source, record.external_id, huge, 'x'.repeat(70_000), signature, null);

    const page = await inspect(state.path, ['--source', 'wikidata', '--record', 'Q1', '--page', 'semantic', '--json']);
    expect(page.code).toBe(0);
    const rows = JSON.parse(page.stdout).page.rows as { key: string; display: string; reason: string | null }[];
    expect(rows.map((row) => row.key)).toEqual([bad, good, huge]);
    expect(rows[0]).toMatchObject({ display: 'unavailable' });
    expect(rows[1]).toMatchObject({ display: 'retained' });
    expect(rows[2]).toMatchObject({ display: 'unavailable' });
    expect(rows[2]!.reason).toContain('65536-byte inspection budget');

    const hostile = await inspect(state.path, ['--source', 'wikidata\u001b[31m', '--record', 'Q1', '--json']);
    expect(hostile.code).toBe(2);
    expect(hostile.stdout).not.toContain('\u001b');
    expect(JSON.parse(hostile.stdout).error).toContain('source identifier');

    const cancelled = await runImportCli(
      ['inspect-bindings', '--state', state.path, '--source', 'wikidata', '--record', 'Q1', '--json'],
      { signal: AbortSignal.abort() },
    );
    expect(cancelled.code).toBe(130);
    expect(cancelled.openHandles).toBe(0);
  } finally {
    state.close();
  }
});

test('a later acknowledgement is visible only on a new invocation', async () => {
  const state = fixture();
  try {
    const record = owner('wikidata', 'Q42');
    const requestKey = key(record, 'bootstrap');
    const signature = 'e'.repeat(64);
    state.bindings.prepare(record, signature, createRequest(record, requestKey));
    const first = await inspect(state.path, [
      '--source',
      'wikidata',
      '--record',
      'Q42',
      '--page',
      'semantic',
      '--request',
      requestKey,
      '--json',
    ]);
    expect(JSON.parse(first.stdout).binding.state).toBe('pending');
    expect(JSON.parse(first.stdout).request.row.acknowledgement).toBe('absent');
    state.bindings.acknowledge(record, requestKey, createAck(requestKey, uuid(4)));
    const second = await inspect(state.path, [
      '--source',
      'wikidata',
      '--record',
      'Q42',
      '--page',
      'semantic',
      '--request',
      requestKey,
      '--json',
    ]);
    expect(JSON.parse(second.stdout).binding.state).toBe('bound');
    expect(JSON.parse(second.stdout).request.row.acknowledgement).toBe('present');
    expect(JSON.parse(second.stdout).request.row.native.subject).toBe(uuid(4));
  } finally {
    state.close();
  }
});
