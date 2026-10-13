import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clearVerifiedImmutableObjectCache, ObjectReadBudgetExceeded,
  rememberVerifiedImmutableObject, S3ImmutableObjects }
  from '../src/infrastructure/immutable-objects.ts';
import { prepareComponent } from '../src/modules/work/activate.ts';
import { readComponentState, readWorkComponentState, RevisionReadBudgetExceeded }
  from '../src/modules/work/history.ts';

afterEach(() => clearVerifiedImmutableObjectCache());

for (const refusedObject of ['manifest', 'payload'] as const) {
  test(`revision ${refusedObject} budget refusal retains the exact immutable-object cause`, async () => {
    const temp = resolve(import.meta.dir, '../../../.temp');
    mkdirSync(temp, { recursive: true });
    const directory = mkdtempSync(join(temp, 'work-revision-budget-'));
    const objects = new S3ImmutableObjects({ endpoint: 'http://127.0.0.1:1',
      bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
      prefix: 'semantic/work/' });
    const get = objects.get.bind(objects);
    let caught: unknown;
    const observation = spyOn(objects, 'get').mockImplementation(async (...args) => {
      try { return await get(...args); }
      catch (error) { caught = error; throw error; }
    });
    try {
      const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
      const state = { title: 'Retained revision', language: 'en' };
      const manifest = prepareComponent(directory, work, state);
      const manifestIri = `urn:rezics:sha256:${manifest}`;
      // Verify the real local objects before using the store's existing cache path.
      expect(readComponentState(directory, manifestIri, work, undefined, undefined,
        rememberVerifiedImmutableObject)).toEqual(state);
      const manifestBytes = statSync(join(directory, manifest)).size;
      const payload = (JSON.parse(readFileSync(join(directory, manifest), 'utf8')) as { payload: string }).payload.slice(7);
      const initialBytes = refusedObject === 'manifest' ? manifestBytes - 1
        : manifestBytes + statSync(join(directory, payload)).size - 1;
      const budget = { bytesLeft: initialBytes, signal: new AbortController().signal };
      const refusal = await readWorkComponentState({ objectDirectory: directory, workObjects: objects },
        manifestIri, work, undefined, budget).then(() => undefined, error => error);

      expect(caught).toBeInstanceOf(ObjectReadBudgetExceeded);
      expect(refusal).toBeInstanceOf(RevisionReadBudgetExceeded);
      expect(refusal.cause).toBe(caught);
      expect(refusal.message).toBe('immutable object exceeds its read budget');
      expect(refusal.message).toBe((caught as Error).message);
      expect(budget.bytesLeft).toBe(initialBytes - (refusedObject === 'payload' ? manifestBytes : 0));
      expect(observation).toHaveBeenCalledTimes(refusedObject === 'manifest' ? 1 : 2);
    } finally {
      observation.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
