import { expect, test } from 'bun:test';
import {
  withLoanHttpWork,
  type LoanHttpWorkContext,
  type LoanHttpWorkOwner,
} from '../../src/library/loan-operation-bounds.ts';
import type { Actor } from '../../src/request/access.ts';

test('loan HTTP work forwards one original request frame with zero worker allowance', async () => {
  const request = new Request('https://kernel.test/v1/copy-loans?filter=open');
  const actor = {} as Actor;
  const context: LoanHttpWorkContext = Object.freeze({
    operation: 'list',
    request,
    actor,
    deadline: Date.now() + 60_000,
    input: Object.freeze({ filter: 'open', limit: 100 }),
    workerAllowance: 0,
  });
  let received: LoanHttpWorkContext | undefined;
  let dispatches = 0;
  const owner: LoanHttpWorkOwner = async (original, dispatch) => {
    received = original;
    return dispatch();
  };

  const result = await withLoanHttpWork(owner, context, async () => {
    dispatches++;
    return 'page';
  });

  expect(received).toBe(context);
  expect(received?.request).toBe(request);
  expect(received?.actor).toBe(actor);
  expect(received?.deadline).toBe(context.deadline);
  expect(received?.workerAllowance).toBe(0);
  expect(dispatches).toBe(1);
  expect(result).toBe('page');
});
