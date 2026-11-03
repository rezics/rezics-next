import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BATCH_PREFLIGHT_NOTE,
  MAX_BATCH_JOBS,
  MAX_BATCH_MANIFEST_BYTES,
  preflightBatchManifest,
  revalidateJobInputs,
} from '../src/batch-manifest.ts';

const bangumi = '{"id":1001,"type":2,"name":"Lantern"}\n';
const openlibrary =
  '/type/work\t/works/OL1W\t1\t2020-01-01T00:00:00Z\t{"type":{"key":"/type/work"},"key":"/works/OL1W","revision":1,"title":"A Catalogue Journey"}\n';

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'batch-manifest-'));
  const bangumiDump = join(directory, 'bangumi.jsonl');
  const libraryDump = join(directory, 'openlibrary.tsv');
  const state = join(directory, 'state.sqlite');
  const nested = join(directory, 'feeds');
  await mkdir(nested);
  await writeFile(bangumiDump, bangumi, { mode: 0o600 });
  await writeFile(libraryDump, openlibrary, { mode: 0o600 });
  await writeFile(state, '', { mode: 0o600 });
  await writeFile(join(nested, 'bangumi.jsonl'), bangumi, { mode: 0o600 });
  return { directory, bangumiDump, libraryDump, state, nested };
}

async function writeManifest(directory: string, document: unknown, name = 'batch.json') {
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  return path;
}

test('preflight resolves relative paths and reports local-only validation', async () => {
  const { directory, state } = await workspace();
  const path = await writeManifest(directory, {
    version: 1,
    jobs: [
      { source: 'bangumi', dump: 'feeds/bangumi.jsonl', state: 'state.sqlite', name: 'bangumi-launch' },
      { source: 'openlibrary', sourceAlias: 'catalogue-ol', dump: 'openlibrary.tsv', state: 'state.sqlite' },
    ],
  });
  const plan = await preflightBatchManifest(path);
  expect(plan.jobs).toHaveLength(2);
  expect(plan.jobs[0]!.dump.path).toBe(join(directory, 'feeds/bangumi.jsonl'));
  expect(plan.jobs[0]!.state.path).toBe(state);
  expect(plan.jobs[0]!.inputMode).toBe('file');
  expect(plan.jobs[1]!.sourceAlias).toBe('catalogue-ol');
  expect(plan.note).toBe(BATCH_PREFLIGHT_NOTE);
});

test('preflight refuses late malformed jobs, duplicates, dump-set, missing files and aliases', async () => {
  const { directory } = await workspace();
  const jobs = Array.from({ length: 15 }, (_, index) => ({
    source: 'wikidata',
    sourceAlias: `wd-${index + 1}`,
    dump: 'bangumi.jsonl',
    state: 'state.sqlite',
  }));
  const tooMany = await writeManifest(directory, {
    version: 1,
    jobs: [...jobs, { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' }, { source: 'vndb' }],
  });
  await expect(preflightBatchManifest(tooMany)).rejects.toThrow(`at most ${MAX_BATCH_JOBS}`);

  const late = await writeManifest(directory, {
    version: 1,
    jobs: [
      { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' },
      { source: 'openlibrary', dump: 'openlibrary.tsv', state: 'state.sqlite', dumpSet: 'authors-works-editions.json' },
    ],
  });
  await expect(preflightBatchManifest(late)).rejects.toThrow('dump-set manifest is one job');

  const duplicate = await writeManifest(directory, {
    version: 1,
    jobs: [
      { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' },
      { source: 'bangumi', dump: 'feeds/bangumi.jsonl', state: 'state.sqlite' },
    ],
  });
  await expect(preflightBatchManifest(duplicate)).rejects.toThrow('both declare configured source');

  const missing = await writeManifest(directory, {
    version: 1,
    jobs: [{ source: 'bangumi', dump: 'missing.jsonl', state: 'state.sqlite' }],
  });
  await expect(preflightBatchManifest(missing)).rejects.toThrow('does not exist');

  const gzip = await writeManifest(directory, {
    version: 1,
    jobs: [{ source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite', compression: 'gzip' }],
  });
  await expect(preflightBatchManifest(gzip)).rejects.toThrow('gzip compression is only admitted');

  const stdin = await writeManifest(directory, {
    version: 1,
    jobs: [{ source: 'bangumi', dump: '-', state: 'state.sqlite' }],
  });
  await expect(preflightBatchManifest(stdin)).rejects.toThrow('cannot be stdin');
});

test('same-file state aliases and input replacement are refused', async () => {
  const { directory, bangumiDump } = await workspace();
  await writeFile(join(directory, 'state-alias.sqlite'), '', { mode: 0o600 });
  await symlink(join(directory, 'state.sqlite'), join(directory, 'state-link.sqlite'));
  const aliased = await writeManifest(directory, {
    version: 1,
    jobs: [
      { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' },
      { source: 'openlibrary', dump: 'openlibrary.tsv', state: 'state-link.sqlite' },
    ],
  });
  await expect(preflightBatchManifest(aliased)).rejects.toThrow('symbolic link');

  const planPath = await writeManifest(directory, {
    version: 1,
    jobs: [
      { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' },
      { source: 'openlibrary', sourceAlias: 'catalogue-ol', dump: 'openlibrary.tsv', state: 'state.sqlite' },
    ],
  });
  const plan = await preflightBatchManifest(planPath);
  await writeFile(bangumiDump, `${bangumi}{"id":1002,"type":2,"name":"Harbor"}\n`, { mode: 0o600 });
  await expect(revalidateJobInputs(plan.jobs[0]!, plan.directory)).rejects.toThrow(
    'changed between local preview and execution',
  );
});

test('manifest size cap is 64KiB', async () => {
  const { directory } = await workspace();
  const path = join(directory, 'huge.json');
  await writeFile(path, `${'a'.repeat(MAX_BATCH_MANIFEST_BYTES + 1)}\n`, { mode: 0o600 });
  await expect(preflightBatchManifest(path)).rejects.toThrow('64');
});
