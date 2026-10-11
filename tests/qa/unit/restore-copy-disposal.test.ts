import { expect, test } from 'bun:test';
import {
  attemptRestoreCleanup,
  createRestoreCopyDisposal,
} from '../fault-recovery/owner-restore-erasure-fixture.ts';

test('disposing a copy releases only its resources and is harmless when repeated', async () => {
  const resources = [
    'candidate pools',
    'candidate graph',
    'candidate PostgreSQL',
    'candidate retained relay database',
    'candidate graph volume',
    'candidate directories and objects',
  ];
  const candidate = new Set(resources);
  const retained = new Set(['source cut', 'immutable relay template', 'sibling copy']);
  const attempts: string[] = [];
  const dispose = createRestoreCopyDisposal(
    resources.map((resource) => ({
      resource,
      run: () => {
        attempts.push(resource);
        candidate.delete(resource);
      },
    })),
  );

  await dispose();

  expect(candidate.size).toBe(0);
  expect(retained).toEqual(new Set(['source cut', 'immutable relay template', 'sibling copy']));
  expect(attempts).toEqual(resources);

  await dispose();

  expect(attempts).toEqual(resources);
});

test('final cleanup tries every partially allocated resource and retries only failures', async () => {
  const outstanding = new Set<string>();
  const retained = new Set(['source cut', 'immutable relay template', 'sibling copy']);
  const allocations = ['candidate retained relay database', 'candidate graph volume'];
  const allocate = () => {
    for (const resource of allocations) outstanding.add(resource);
    throw new Error('candidate allocation fault');
  };

  expect(allocate).toThrow('candidate allocation fault');

  const failedOnce = new Set(['candidate graph volume']);
  const attempts = new Map<string, number>();
  const cleanup = (resource: string) => ({
    resource,
    run: () => {
      attempts.set(resource, (attempts.get(resource) ?? 0) + 1);
      if (failedOnce.has(resource)) {
        failedOnce.delete(resource);
        throw new Error(`${resource} removal fault`);
      }
      outstanding.delete(resource);
    },
  });

  const firstFailures = await attemptRestoreCleanup([...outstanding].map(cleanup));

  expect(firstFailures.map(({ action }) => action.resource)).toEqual(['candidate graph volume']);
  expect([...attempts.keys()]).toEqual(allocations);
  expect(outstanding).toEqual(new Set(['candidate graph volume']));
  expect(retained).toEqual(new Set(['source cut', 'immutable relay template', 'sibling copy']));

  const finalFailures = await attemptRestoreCleanup([...outstanding].map(cleanup));

  expect(finalFailures).toEqual([]);
  expect(outstanding.size).toBe(0);
  expect(attempts.get('candidate retained relay database')).toBe(1);
  expect(attempts.get('candidate graph volume')).toBe(2);
  expect(retained).toEqual(new Set(['source cut', 'immutable relay template', 'sibling copy']));
});

test('partial disposal reports failures and retries only resources still owned', async () => {
  const resources = ['candidate pools', 'candidate graph', 'candidate PostgreSQL', 'candidate files'];
  const outstanding = new Set(resources);
  const failOnce = new Set(['candidate graph']);
  const attempts = new Map<string, number>();
  const dispose = createRestoreCopyDisposal(
    resources.map((resource) => ({
      resource,
      run: () => {
        attempts.set(resource, (attempts.get(resource) ?? 0) + 1);
        if (failOnce.has(resource)) {
          failOnce.delete(resource);
          throw new Error(`${resource} removal fault`);
        }
        outstanding.delete(resource);
      },
    })),
  );

  await expect(dispose()).rejects.toThrow('restore copy disposal failed');

  expect(outstanding).toEqual(new Set(['candidate graph']));
  expect([...attempts.keys()]).toEqual(resources);

  await dispose();

  expect(outstanding.size).toBe(0);
  expect(attempts.get('candidate pools')).toBe(1);
  expect(attempts.get('candidate graph')).toBe(2);
  expect(attempts.get('candidate PostgreSQL')).toBe(1);
  expect(attempts.get('candidate files')).toBe(1);
});
