import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DumpPreview } from '../src/dump-preview.ts';
import { parsePreviewArgs, runPreviewCli } from '../src/preview-cli.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';
import workSource from '../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../specs/fixtures/imports/open-library/edition.json';

const author = {
  type: { key: '/type/author' },
  key: '/authors/OL900000001A',
  revision: 1,
  last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
  name: 'Ada Example',
};

function row(record: {
  type: { key: string };
  key: string;
  revision: number;
  last_modified?: { value: string };
  title?: string;
}) {
  const date = record.last_modified?.value ?? '2025-01-01T00:00:00Z';
  return `${[record.type.key, record.key, record.revision, date, JSON.stringify(record)].join('\t')}\n`;
}

async function completedBaseline(path: string, keys: string[]) {
  const database = new Database(path, { create: true, strict: true });
  const store = new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
  const source = 'openlibrary';
  const run = store.begin(source);
  if (run === 'busy') throw new Error('expected generation');
  for (const key of keys) {
    store.stage(run, {
      row: {
        source,
        recordKey: key,
        recordRevision: '1',
        digest: 'a'.repeat(64),
        converter_revision: 'open-library@1',
        state: 'present',
      },
      projection: { sourceKind: 'openlibrary', normalizedRecord: { key } },
    });
  }
  expect(store.seal(run, { complete: true }).status).toBe('ready');
  for (const key of keys) {
    store.classify(run, key, { commands: [] });
    store.acknowledgeNoEffects(run, key, { reason: 'no-owned-candidates' });
  }
  expect(store.finalize(run, 100)).toBe('complete');
  store.close();
}

async function mixedManifest(
  root: string,
  files: { authors?: string; works?: string; editions?: string | Uint8Array },
) {
  await writeFile(join(root, 'authors.txt.gz'), gzipSync(Buffer.from(files.authors ?? row(author))), { mode: 0o600 });
  await writeFile(join(root, 'works.txt'), files.works ?? row(workSource), { mode: 0o600 });
  const editions = files.editions ?? row(editionSource);
  await writeFile(
    join(root, 'editions.txt.gz'),
    editions instanceof Uint8Array ? editions : gzipSync(Buffer.from(editions)),
    { mode: 0o600 },
  );
  const path = join(root, 'manifest.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      source: 'openlibrary',
      members: [
        { family: 'author', path: 'authors.txt.gz', compression: 'gzip' },
        { family: 'work', path: 'works.txt', compression: 'none' },
        { family: 'edition', path: 'editions.txt.gz', compression: 'gzip' },
      ],
    }),
    { mode: 0o600 },
  );
  return path;
}

test('preview dump-set is exclusive with --dump and --plan-dir and lists families in help', async () => {
  expect(() => parsePreviewArgs(['--source', 'openlibrary', '--dump', 'a', '--dump-set', 'b'])).toThrow(
    '--dump-set cannot be combined with --dump',
  );
  expect(() => parsePreviewArgs(['--plan-dir', 'kept', '--dump-set', 'b'])).toThrow(
    '--plan-dir reopens a retained preview',
  );
  expect(() => parsePreviewArgs(['--source', 'openlibrary', '--dump-set', 'b', '--compression', 'gzip'])).toThrow(
    '--compression does not apply',
  );
  const help = await runPreviewCli(['--help']);
  expect(help.stdout).toContain('--dump-set');
  expect(help.stdout).toContain('whole-set decoded-byte ceiling');
});

test('preview compares a mixed gzip/plain set, reopens without members, and withholds vanished on a late failure', async () => {
  const root = await mkdtemp('/dev/shm/ol-set-preview-');
  try {
    const baseline = join(root, 'state.sqlite');
    await completedBaseline(baseline, [workSource.key, editionSource.key, '/works/OL900000099W']);
    const dumpSet = await mixedManifest(root, {
      works: row({ ...workSource, revision: 2, title: 'Revised work' }),
    });
    const output = join(root, 'plan');
    const preview = await DumpPreview.build({
      source: 'openlibrary',
      dumpSet,
      baseline,
      outputDir: output,
    });
    try {
      expect(preview.plan.complete).toBe(true);
      expect(preview.plan.inputKind).toBe('dump-set');
      expect(preview.plan.inputFamilies.map((member) => `${member.family}=${member.compression}`)).toEqual([
        'author=gzip',
        'work=none',
        'edition=gzip',
      ]);
      expect(preview.plan.changedCount).toBeGreaterThanOrEqual(1);
      expect(preview.plan.vanishedCount).toBe(1);
      expect(preview.page('vanished').rows.map((row) => row.recordKey)).toEqual(['/works/OL900000099W']);
      expect(preview.record(workSource.key).found).toBe(true);
    } finally {
      await preview.close();
    }

    await rm(join(root, 'authors.txt.gz'));
    await rm(join(root, 'works.txt'));
    await rm(join(root, 'editions.txt.gz'));
    const reopened = await DumpPreview.open(output);
    try {
      expect(reopened.plan.complete).toBe(true);
      expect(reopened.plan.vanishedCount).toBe(1);
      expect(reopened.record(editionSource.key).found).toBe(true);
    } finally {
      await reopened.close();
    }

    const cli = await runPreviewCli(['--source', 'openlibrary', '--dump-set', dumpSet, '--json']);
    expect(cli.code).toBe(2);

    const broken = await mixedManifest(root, {
      editions: Buffer.concat([gzipSync(Buffer.from(row(editionSource))), Buffer.from('trail')]),
    });
    const incomplete = await DumpPreview.build({ source: 'openlibrary', dumpSet: broken, baseline });
    try {
      expect(incomplete.plan.complete).toBe(false);
      expect(incomplete.plan.errorIdentity).toBe('gzip-trailing-garbage');
      expect(incomplete.plan.errorMessage).toContain('member 2');
      expect(incomplete.plan.vanishedCount).toBe(0);
      expect(() => incomplete.page('vanished')).toThrow('Incomplete input cannot present a vanished membership page');
    } finally {
      await incomplete.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
