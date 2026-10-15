import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createAdmittedTextContribution } from '../src/modules/contribution/create-admitted.ts';
import { editAdmittedTextContribution } from '../src/modules/contribution/edit-admitted.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';

test('Contribution writers reject missing Content fences before creating a durable admission', async () => {
  let touched = false;
  const unavailable = () => { touched = true; throw new Error('preflight must precede dependencies'); };
  const account = { verify: unavailable };
  const access = { register: unavailable, claim: unavailable, recordGraphOutcome: unavailable };
  const request = new Request('https://main.rezics.test/v1/contributions');
  for (const referenceFencePool of [undefined, {} as Pool]) {
    const env = { referenceFencePool, fuseki: { query: unavailable } } as unknown as WorkActivationEnvironment;
    await expect(createAdmittedTextContribution(env, account, access, request, {
      work, actingSubject: actor, language: 'en', body: 'Draft body', idempotencyKey: 'create',
    })).rejects.toThrow('Contribution reference fence pool is required');
    await expect(editAdmittedTextContribution(env, account, access, request, {
      contribution: work, expectedHead: revision, actingSubject: actor, body: 'Edited body', idempotencyKey: 'edit',
    })).rejects.toThrow('Contribution reference fence pool is required');
  }
  expect(touched).toBe(false);
});
