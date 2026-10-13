import { expect, test } from 'bun:test';
import { writePlan } from './api.ts';
import type { Plan } from './intents.ts';
import type { MainClient } from '../studio/types.ts';

const measure = { value: { numerator: 1, denominator: 1 }, unitText: 'portion', coverage: 'complete', provenance: 'declared' } as const;
const plans: Plan[] = [{ kind: 'yield', body: { yield: measure } }, { kind: 'timings', body: { cooking: measure } }];

test.each(plans)('Recipe %s admission remains pending and reuses the caller key', async plan => {
  const keys: string[] = [];
  let status = 202;
  const post = async (_body: unknown, options: { headers: { 'idempotency-key': string } }) => {
    keys.push(options.headers['idempotency-key']);
    return { status, error: null, data: status === 202
      ? { type: 'about:blank', title: 'Applying', status: 202, code: 'write_pending' }
      : { revision: 'committed-head' } };
  };
  const main = { v1: { recipes: () => ({ measures: { post }, timings: { post } }) } } as unknown as MainClient;
  const input = { structure: 'recipe-id', head: 'current-head', actingSubject: 'cook', plan, key: 'retained-recipe-command' };
  const pending = { ok: false, status: 202, problem: 'pending', detail: null } as const;
  expect(await writePlan(main, input)).toEqual(pending);
  expect(await writePlan(main, input)).toEqual(pending);
  status = 200;
  expect(await writePlan(main, input)).toEqual({ ok: true, data: { revision: 'committed-head' } });
  expect(keys).toEqual([input.key, input.key, input.key]);
});
