import { expect, test } from 'bun:test';
import { runSelectedFollowsWitness } from './support/selected-follows.ts';

test(
  'native selected follows graph stays acyclic through Context selection and identity merging',
  async () => {
    const observations = await runSelectedFollowsWitness();
    const violations = observations.flatMap((observation) =>
      observation.violations.map((violation) => `${observation.name}: ${violation}`),
    );
    expect(violations, `Native selected follows evidence:\n${JSON.stringify(observations, null, 2)}`).toEqual([]);
  },
  180_000,
);
