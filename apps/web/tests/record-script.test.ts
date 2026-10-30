import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeRecording, normalizeSearchRecording } from '../scripts/recording-normalization';

test('Search recording normalization follows current response rows and keeps the prior stable timestamp', () => {
  const genjiId = '01a1773a-f700-7078-8000-000000000001';
  const princeId = '01a17dfd-5dbf-738a-9405-9dfa9a8ec069';
  const previous = {
    as_of: '2026-10-29T00:00:00Z',
    subjects: Array.from({ length: 5 }, (_, index) => ({
      id: index === 0 ? genjiId : princeId,
      type: 'schema:Book',
      labels: { en: index === 0 ? 'The Tale of Genji' : 'The Little Prince' },
    })),
  };
  const current = {
    as_of: '2026-10-30T00:00:00Z',
    subjects: [
      { id: genjiId, type: 'schema:Book', labels: { en: 'The Tale of Genji' } },
      { id: princeId, type: 'schema:Book', labels: { en: 'The Little Prince' } },
    ],
  };

  const normalized = normalizeSearchRecording(current, previous, 'zh-Hans') as {
    as_of: string;
    subjects: { id: string; labels: Record<string, string> }[];
  };
  expect(normalized.subjects.map(({ id }) => id)).toEqual([genjiId, princeId]);
  expect(normalized.subjects.map(({ labels }) => labels['zh-Hans'])).toEqual(['源氏物语', '小王子']);
  expect(normalized.as_of).toBe(previous.as_of);
  expect(normalizeSearchRecording(normalized, previous, 'zh-Hans')).toEqual(normalized);
});

test('Search recording normalization never aliases fixture identities by a matching title', () => {
  const sharedTitle = 'The Little Prince';
  const subjects = [
    { id: '01a17a3b-0884-721b-91ef-d7ffd7bb58e4', type: 'schema:Book', labels: { en: sharedTitle } },
    { id: '01a17dfd-5dbf-738a-9405-9dfa9a8ec068', type: 'schema:Book', labels: { en: sharedTitle } },
  ];

  const normalized = normalizeSearchRecording({ subjects }, undefined, 'en') as {
    subjects: { id: string; labels: Record<string, string> }[];
  };
  expect(normalized.subjects.map(({ id }) => id)).toEqual(subjects.map(({ id }) => id));
  expect(normalized.subjects.map(({ labels }) => labels.en)).toEqual([sharedTitle, sharedTitle]);
});

test('subject-page normalization applies its explicit recorder identity to every aggregate reference', () => {
  const transientId = '00000000-0000-4000-8000-000000000001';
  const recordedId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
  const staleId = '01a17dfd-5dbf-738a-9405-9dfa9a8ec069';
  const current = {
    subject: transientId,
    views: { '0': { id: 'view-0' }, '1': { id: 'view-1' } },
    reads: {
      r0: {
        body: {
          subject: { id: transientId, type: 'schema:Book', labels: { en: 'The Little Prince' } },
          summary: { id: transientId, type: 'schema:Book' },
          related: { schema: 'preserved' },
        },
      },
      r1: { body: { links: [{ subjectId: transientId }, { subjectId: '00000000-0000-4000-8000-000000000002' }] } },
    },
  };
  const previous = {
    subject: recordedId,
    views: { '0': { id: 'view-0' }, '1': { id: 'view-1' } },
    reads: {
      r0: {
        body: {
          subject: { id: staleId, type: 'schema:Book', labels: { en: 'The Little Prince' } },
          summary: { id: staleId, type: 'schema:Book' },
          related: { schema: 'preserved' },
        },
      },
      r1: { body: { links: [{ subjectId: staleId }, { subjectId: '00000000-0000-4000-8000-000000000099' }] } },
    },
  };

  const normalized = normalizeRecording(
    current,
    previous,
    'en',
    new Map([[transientId, recordedId]]),
  ) as typeof current;
  expect(normalized.subject).toBe(recordedId);
  expect(normalized.reads.r0.body.subject.id).toBe(recordedId);
  expect(normalized.reads.r0.body.summary.id).toBe(recordedId);
  expect(normalized.reads.r1.body.links.map(({ subjectId }) => subjectId)).toEqual([
    recordedId,
    '00000000-0000-4000-8000-000000000099',
  ]);
  expect(Object.keys(normalized.views)).toEqual(['0', '1']);
  expect(Object.keys(normalized.reads)).toEqual(['r0', 'r1']);
});

const root = resolve(import.meta.dir, '../../..');
const stackAvailable =
  Bun.which('docker') !== null &&
  Bun.spawnSync(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

test.skipIf(!stackAvailable)(
  'the recorder writes a subject page with two editions',
  async () => {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const output = mkdtempSync(join(root, '.temp/web-record-test-'));
    try {
      const child = Bun.spawn(['bun', 'apps/web/scripts/record.ts', 'subject-page'], {
        cwd: root,
        env: { ...process.env, WEB_RECORD_OUTPUT: output },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const page = await Bun.file(join(output, 'subject-page.json')).json();
      const reads = Object.values(page.reads) as { status: number; body: { links?: { property: string }[] } }[];
      const editions = reads.find((read) => read.body.links?.some((link) => link.property === 'schema:exampleOfWork'));
      expect(editions?.status).toBe(200);
      expect(editions?.body.links).toHaveLength(2);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  },
  600_000,
);

test.skipIf(!stackAvailable)(
  'the recorder replaces existing definitions snapshots with the current bundled release',
  async () => {
    const { bundledDigest, bundledRelease } = await import('@rezics/definitions/bundled');
    mkdirSync(join(root, '.temp'), { recursive: true });
    const output = mkdtempSync(join(root, '.temp/web-definitions-record-test-'));
    try {
      await Bun.write(
        join(output, 'definitions-active.json'),
        JSON.stringify({ digest: 'stale', head: 1, status: 200 }),
      );
      await Bun.write(
        join(output, 'definitions-release.json'),
        JSON.stringify({ digest: 'stale', release: { types: { 'schema:Book': { coverRatio: '2:3' } } }, status: 200 }),
      );
      const child = Bun.spawn(['bun', 'apps/web/scripts/record.ts', 'definitions-active', 'definitions-release'], {
        cwd: root,
        env: { ...process.env, WEB_RECORD_OUTPUT: output },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const active = await Bun.file(join(output, 'definitions-active.json')).json();
      const release = await Bun.file(join(output, 'definitions-release.json')).json();
      expect(active.digest).toBe(bundledDigest);
      expect(release.digest).toBe(bundledDigest);
      expect(release.release).toEqual(bundledRelease);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  },
  600_000,
);
