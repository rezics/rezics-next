import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertOwnerMigrationsComplete, type OwnerMigrationEvidence } from '../../../scripts/fixture/migrate.ts';
import { readFormatMarker, saveFormatMarker, saveInstallFormatMarker, type FormatMarker } from '../../../scripts/dev/install.ts';
import { stackDirectory, type StackOptions } from '../../../scripts/dev/config.ts';

test('G991: a deferred owner migration fails development and survives release restart until a successful retry', () => {
  const deferred: OwnerMigrationEvidence[] = [{ owner: 'graph-aliases', status: 'deferred',
    reason: 'Graph-alias import is incomplete; resolve the reported import error and rerun owner migrations' }];
  expect(() => assertOwnerMigrationsComplete(deferred)).toThrow('Owner migrations deferred: graph-aliases');
  const options: StackOptions = { profile: 'qa', runId: `g991-${randomUUID().slice(0, 8)}` };
  const directory = stackDirectory(process.cwd(), options);
  mkdirSync(directory, { recursive: true });
  const marker: FormatMarker = { schema: 'rezics-format-marker-v1', formatVersion: 1,
    releaseDigest: 'release', fusekiImageId: 'image', dataEpoch: 'epoch', routingEpoch: 'routing',
    state: 'ready', ownerMigrations: deferred };
  try {
    saveFormatMarker(options, marker);
    expect(readFormatMarker(options)?.ownerMigrations).toEqual(deferred);
    const complete: OwnerMigrationEvidence[] = [{ owner: 'graph-aliases', status: 'complete' }];
    assertOwnerMigrationsComplete(complete);
    saveFormatMarker(options, { ...marker, ownerMigrations: complete });
    expect(readFormatMarker(options)?.ownerMigrations).toEqual(complete);
    expect(readFormatMarker(options)?.state).toBe('ready');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('format marker retains completed migration evidence on a matching re-install', () => {
  const options: StackOptions = { profile: 'qa', runId: `owner-evidence-${randomUUID().slice(0, 8)}` };
  const directory = stackDirectory(process.cwd(), options);
  const markerPath = join(directory, 'release-format.json');
  mkdirSync(directory, { recursive: true });
  const applied: OwnerMigrationEvidence[] = [
    { owner: 'catalogue-statements', status: 'complete', converted: 0, replayed: 0, noop: false },
    { owner: 'ordered-membership', status: 'complete', placements: 0, receipts: [] },
    { owner: 'graph-aliases', status: 'complete' },
  ];
  const repeated: OwnerMigrationEvidence[] = [
    { owner: 'catalogue-statements', status: 'complete', converted: 0, replayed: 0, noop: true },
    { owner: 'ordered-membership', status: 'complete', placements: 0, receipts: [] },
    { owner: 'graph-aliases', status: 'complete' },
  ];
  const marker: FormatMarker = { schema: 'rezics-format-marker-v1', formatVersion: 1,
    releaseDigest: 'release', fusekiImageId: 'image', dataEpoch: 'epoch', routingEpoch: 'routing',
    state: 'ready', ownerMigrations: applied };

  try {
    saveFormatMarker(options, marker);
    const appliedBytes = readFileSync(markerPath, 'utf8');
    saveInstallFormatMarker(options, { ...marker, ownerMigrations: repeated });
    expect(readFileSync(markerPath, 'utf8')).toBe(appliedBytes);
    expect(readFormatMarker(options)?.ownerMigrations).toEqual(applied);

    const deferred: OwnerMigrationEvidence[] = [
      ...repeated.slice(0, 2),
      { owner: 'graph-aliases', status: 'deferred', reason: 'Graph-alias import is incomplete' },
    ];
    saveInstallFormatMarker(options, { ...marker, ownerMigrations: deferred });
    const deferredBytes = readFileSync(markerPath, 'utf8');
    expect(deferredBytes).not.toBe(appliedBytes);
    expect(readFormatMarker(options)?.ownerMigrations).toEqual(deferred);

    saveInstallFormatMarker(options, { ...marker, releaseDigest: 'next-release', ownerMigrations: repeated });
    expect(readFileSync(markerPath, 'utf8')).not.toBe(deferredBytes);
    expect(readFormatMarker(options)).toMatchObject({
      releaseDigest: 'next-release', ownerMigrations: repeated,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
