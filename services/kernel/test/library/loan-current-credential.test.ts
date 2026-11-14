import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GrantDeniedError } from '../../src/access/contract/errors.ts';
import { createLoanCommands } from '../../src/library/loan-commands.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accountToken } from '../support/admitted-access.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let native: NativeProfileFixture;
let loans: ReturnType<typeof createLoanCommands>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  native = await createProfileEntryFixture({ ownerScopes: ['copy:list'] });
  loans = createLoanCommands({
    pool: native.pool,
    access: native.access,
    tokens: native.tokens,
    routeKey: testRouteKey(),
  });
}, 120_000);

afterAll(async () => native?.close());

test('current owner reads every page shape; a floor advance during enrichment denies the retired credential', async () => {
  const owner = native.owner.actor;
  const route = routeOf(owner.accountId)!;
  for (const filter of ['open', 'history'] as const)
    expect((await loans.listLoans(owner, { filter, limit: 20 })).items).toEqual([]);

  const openLoanId = newId(route);
  const historyLoanId = newId(route);
  await native.pool.query(
    `INSERT INTO library.copy_loan
       (route,loan_id,account_id,copy_id,direction,counterparty_kind,counterparty_name,started_on,due_on,
        returned_on,created_at,updated_at,transaction_id)
     VALUES ($1,$2,$3,$4,'lent','name','Open counterparty','2026-10-01','2026-10-20',NULL,now(),now(),$5),
            ($1,$6,$3,$7,'borrowed','name','History counterparty','2026-09-01','2026-09-20',
             '2026-09-15',now(),now(),$8)`,
    [route, openLoanId, owner.accountId, newId(route), newId(route), historyLoanId, newId(route), newId(route)],
  );

  const pageReady = deferred();
  const enrichment = deferred();
  const delayedResponse = (async () => {
    const page = await loans.listLoans(owner, { filter: 'open', limit: 20 });
    pageReady.resolve();
    await enrichment.promise;
    await loans.assertCurrentOwner(owner);
    return page;
  })();
  await pageReady.promise;
  await native.pool.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
    route,
    owner.accountId,
  ]);
  enrichment.resolve();
  await expect(delayedResponse).rejects.toBeInstanceOf(GrantDeniedError);

  const currentOwner = { ...owner, authnEpoch: 2 };
  for (const [filter, expectedId] of [
    ['open', openLoanId],
    ['history', historyLoanId],
  ] as const) {
    await expect(loans.listLoans(owner, { filter, limit: 20 })).rejects.toBeInstanceOf(GrantDeniedError);
    const page = await loans.listLoans(currentOwner, { filter, limit: 20 });
    expect(page.items.map(({ loan }) => loan.id)).toEqual([expectedId]);
  }
  await expect(loans.assertCurrentOwner(currentOwner)).resolves.toBeUndefined();

  const currentBearer = await accountToken({
    accountId: owner.accountId,
    clientId: owner.clientId,
    scopes: owner.scopes,
    authnEpoch: 2,
    requestedBy: owner.requestedBy,
  });
  const getLoans = (bearer: string, filter: 'open' | 'history') =>
    native.handle(
      new Request(`http://kernel.test/v1/copy-loans?filter=${filter}`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    );
  for (const filter of ['open', 'history'] as const) {
    const current = await getLoans(currentBearer, filter);
    expect(current.status).toBe(200);
    const retired = await getLoans(native.owner.bearer, filter);
    expect(retired.status).not.toBe(200);
    expect(await retired.text()).not.toContain('counterparty');
  }

  await native.pool.query('DELETE FROM library.copy_loan WHERE route=$1 AND account_id=$2', [route, owner.accountId]);
  for (const filter of ['open', 'history'] as const) {
    expect((await loans.listLoans(currentOwner, { filter, limit: 20 })).items).toEqual([]);
    expect((await getLoans(currentBearer, filter)).status).toBe(200);
    await expect(loans.listLoans(owner, { filter, limit: 20 })).rejects.toBeInstanceOf(GrantDeniedError);
  }
});
