import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, datasetRoot } from '../../../scripts/datasets/store.ts';
import {
  fixtureCorpus,
  mainComponentState,
  stable,
  workAt,
  workComponentState,
} from '../../../scripts/fixture/corpus.ts';
import { accessOwner } from '../../../scripts/fixture/owners/access.ts';
import { contentOwner } from '../../../scripts/fixture/owners/content.ts';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';

const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

test('one serializer omits undefined object entries and keeps stored key order', () => {
  expect(canonical).toBe(canonicalJson);
  expect(stable).toBe(canonicalJson);
  expect(canonicalJson({ b: null, a: [2, 1], unset: undefined })).toBe('{"a":[2,1],"b":null}');
  expect(canonicalJson({ z: undefined, m: { k: undefined, j: 1 }, arr: [1, undefined, 3] })).toBe(
    '{"arr":[1,,3],"m":{"j":1}}',
  );
});

test('fixture digests stay on the shared serializer', () => {
  const corpus = fixtureCorpus('small', 'rezics-background-v1', 3);
  const work = workAt(corpus, 0);
  const text = canonicalJson({
    work,
    component: workComponentState(work),
    main: mainComponentState(work),
    access: accessOwner.summarize(corpus),
    content: contentOwner.summarize(corpus),
  });
  expect(sha256(text)).toBe('fe235212a195eae6d9673002d319061d4669502e5fe4609996b9cd9f15f1811f');
});

function storedRecords(root: string): string[] {
  const files = readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(root, name));
  const imports = join(root, 'imports');
  if (existsSync(imports)) {
    for (const name of readdirSync(imports)) {
      const path = join(imports, name);
      if (name.endsWith('.json') && statSync(path).isFile()) files.push(path);
    }
  }
  const snapshots = join(root, 'snapshots');
  if (existsSync(snapshots)) {
    for (const id of readdirSync(snapshots)) {
      const path = join(snapshots, id, 'snapshot.json');
      if (existsSync(path)) files.push(path);
    }
  }
  return files;
}

test('stored dataset records re-hash to the same canonical bytes', () => {
  const root = datasetRoot();
  const files = storedRecords(root);
  expect(files.length).toBeGreaterThan(0);
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    const again = canonicalJson(JSON.parse(text));
    if (sha256(again) !== sha256(body)) throw new Error(`stored dataset record changed: ${path}`);
  }
}, 180_000);
