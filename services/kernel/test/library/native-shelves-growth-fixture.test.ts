import { expect, test } from 'bun:test';
import { createLibraryShelvesDriver } from './support/native-shelves-driver.ts';

test('native shelf growth reaches independent relation totals without changing the tested shelf', async () => {
  const driver = await createLibraryShelvesDriver();
  try {
    const subject = await driver.provisionSubject();
    const created = await driver.request('owner', {
      method: 'PUT',
      path: `/v1/libraryEntries/${subject.id}`,
      headers: { 'Idempotency-Key': `"${Bun.randomUUIDv7()}"` },
      body: { state: 'planned' },
    });
    expect(created.status).toBe(201);
    await driver.settle();
    const readOwner = async () => {
      const response = await driver.request('owner', { method: 'GET', path: '/v1/libraryEntries?limit=100' });
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await readOwner();
    const totals = { entries: 4, activeSessions: 4, inactiveSessions: 4 };
    await driver.seed(totals);
    const grown = await driver.inspect();
    await driver.seed(totals);
    const repeated = await driver.inspect();
    const testedAccounts = new Set([driver.accounts.owner.id, driver.accounts.other.id, driver.accounts.suspended.id]);
    const unrelatedEntries = grown.entries.filter((entry) => !testedAccounts.has(entry.accountId));
    const unrelatedSessions = grown.sessions.filter((session) => !testedAccounts.has(session.accountId));
    const ownerHistory = grown.sessions.filter(
      (session) => session.accountId === driver.accounts.owner.id && session.state !== 'active',
    );
    const entryAccountId = unrelatedEntries[0]?.accountId;
    const activeAccountId = unrelatedSessions[0]?.accountId;
    expect(await readOwner()).toEqual(before);
    expect(unrelatedEntries).toHaveLength(4);
    expect(new Set(unrelatedEntries.map((entry) => entry.subjectId)).size).toBe(4);
    expect(unrelatedSessions.filter((session) => session.state === 'active')).toHaveLength(4);
    expect(activeAccountId).not.toBe(entryAccountId);
    expect(ownerHistory).toHaveLength(4);
    expect(ownerHistory.map((session) => session.state).sort()).toEqual([
      'abandoned',
      'abandoned',
      'completed',
      'completed',
    ]);
    expect(
      grown.completedUnits.filter((unit) => ownerHistory.some((session) => session.id === unit.sessionId)),
    ).toHaveLength(1);
    expect(grown.heads.filter((head) => head.accountId === activeAccountId)).toHaveLength(4);
    expect(grown.typeKeys.filter((key) => key.accountId === entryAccountId)).toHaveLength(1);
    expect(
      grown.counts.some(
        (count) => count.accountId === entryAccountId && count.bucket === 'planned' && count.count === 4,
      ),
    ).toBe(true);
    expect(repeated.entries).toEqual(grown.entries);
    expect(repeated.sessions).toEqual(grown.sessions);
    expect(repeated.completedUnits).toEqual(grown.completedUnits);
  } finally {
    await driver.close();
  }
});
