import { expect, test } from 'bun:test';
import { profileRegistry } from '@rezics/model';
import { SemanticChangeRejected, validationsFor } from '../src/modules/semantic/command.ts';
import { GRAPHS, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const definition = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('a missing authored profile refuses before health or command transport', async () => {
  const env = {} as WorkActivationEnvironment;
  try {
    await validationsFor(env, 'uninstalled-authored-definition', [{ role: 'definition', focus: [definition] }]);
    throw new Error('expected an unavailable profile');
  } catch (error) {
    expect(error).toBeInstanceOf(SemanticChangeRejected);
    expect((error as SemanticChangeRejected).code).toBe('unsupported-model-revision');
  }
});

test('an installed authored profile retains its exact pin, focus, graph set and health check', async () => {
  const profile = 'semantic-definition-v1';
  let current: string = profileRegistry[profile].sha256;
  const env = { fuseki: { async commandHealth() { return { profiles: { [profile]: current } }; } } } as unknown as WorkActivationEnvironment;
  expect(await validationsFor(env, profile, [{ role: 'definition', focus: [definition] }])).toEqual([{
    profile, sha256: current, shape: `https://rezics.com/definition/${profile}/definition-shape`,
    focus: [definition], graphs: [GRAPHS.current, GRAPHS.revisions],
  }]);
  current = 'different-installed-artifact';
  await expect(validationsFor(env, profile, [{ role: 'definition', focus: [definition] }]))
    .rejects.toThrow('differs from reviewed artifact');
});
