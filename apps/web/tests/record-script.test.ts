import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
