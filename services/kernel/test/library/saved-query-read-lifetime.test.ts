import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as command from '../../src/command/command.ts';
import * as plans from '../../src/library/owner-filter-plan.ts';
import * as native from '../../src/library/owner-filter-native-binding.ts';
import * as rules from '../../src/library/collection-rules.ts';
import * as episodes from '../../src/library/collection-publication-episodes.ts';
import { createCollectionReads } from '../../src/library/collection-reads.ts';
import { createCollectionPublicationService } from '../../src/library/collection-publication-service.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
let actor: AccountActor;
let reduced: AccountActor;
let collectionId: string;
let subjectId: string;
let publicationId: string;
const originalBind = plans.bindOwnerFilterRead;
const originalPrepare = rules.prepareCollectionRuleAuthority;
const originalRule = rules.readSavedCollectionRule;
const originalMint = command.mintReadTime;
const originalEpisode = episodes.readCollectionPublicationEpisode;

beforeAll(async () => {
  f = await createCollectionRulesFixture();
  // Publication and native Members preparation may overlap independent read checkouts.
  f.database.pool.options.max = 4;
  const context = { pool: f.database.pool, deadline: Date.now() + 30_000 };
  actor = await f.runtime.identity.access.authenticate(f.owner, context);
  reduced = await f.runtime.identity.access.authenticate(f.reduced, context);
  subjectId = await f.subject('Saved read lifetime');
  await f.entry(subjectId);
  const created = await f.send('POST', '/v1/collections', {
    title: 'Owned read lifetimes',
    membershipKind: 'dynamic',
    visibility: 'private',
    rule: { filter: { owner: { presence: true } }, sort: 'id' },
  });
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  collectionId = collection.id;
  expect((await f.page(collectionId)).members).toContainEqual({ kind: 'dynamic', subjectId });
  const begun = await service().begin(
    actor,
    { collectionId, revision: collection.revision, visibility: 'public' },
    randomUUID(),
  );
  publicationId = begun.value.locator.publicationId;
  const episode = await originalEpisode(f.database.pool, begun.value.locator);
  expect(episode?.source.input.identity).toMatchObject({
    scope: 'private_builtin',
    accountId: actor.accountId,
    collectionId,
  });
  expect(episode?.initiator.recordedTransactionId).toBe(begun.transactionId);
}, 120_000);
afterEach(() => mock.restore());
afterAll(async () => {
  await f?.close();
});

function service() {
  return createCollectionPublicationService({ pool: f.database.pool, access: f.runtime.identity.access });
}
function members() {
  return createCollectionReads({
    pool: f.database.pool,
    access: f.runtime.identity.access,
    tokens: f.runtime.identity.tokenKeys,
  }).readMembers(actor, collectionId);
}
function closed(time: command.AuthoritativeTime) {
  expect(() => command.authoritativeTimeValue(time)).toThrow('Authoritative time is not from a live command attempt');
}
function observeBindings(afterBind?: () => void) {
  const acquired: plans.OwnerFilterReadBinding[] = [];
  const release = spyOn(native, 'releaseNativeOwnerFilterRead');
  spyOn(plans, 'bindOwnerFilterRead').mockImplementation(async (...args) => {
    const result = await originalBind(...args);
    expect(result.status).toBe('bound');
    if (result.status === 'bound') {
      expect(native.nativeOwnerFilterBinding(result.binding)).toBeDefined();
      expect(result.binding.scope.key.source).toMatchObject({
        kind: 'library',
        identity: { scope: 'private_builtin', collectionId, accountId: actor.accountId },
      });
      acquired.push(result.binding);
      afterBind?.();
    }
    return result;
  });
  return () => {
    expect(acquired).toHaveLength(1);
    for (const binding of acquired) {
      expect(release.mock.calls.filter(([value]) => value === binding)).toHaveLength(1);
      closed(binding.input.at);
    }
  };
}

test('a useful native saved Members page closes its binding and fresh final revalidation time', async () => {
  const assertClosed = observeBindings();
  const prepare = spyOn(rules, 'prepareCollectionRuleAuthority');
  const release = spyOn(command, 'releaseOperationalTime');
  expect(await members()).toEqual({ members: [{ kind: 'dynamic', subjectId }], next: null });
  expect(prepare.mock.calls).toHaveLength(2);
  const times = prepare.mock.calls.map(([, , , attempt]) => attempt.time);
  expect(times[0]).not.toBe(times[1]);
  for (const time of times) {
    closed(time);
    expect(release.mock.calls.filter(([value]) => value === time)).toHaveLength(1);
  }
  assertClosed();
}, 120_000);

test('failed post-bind source validation closes the actual native binding', async () => {
  let saved: rules.SavedCollectionRule | null = null;
  spyOn(rules, 'readSavedCollectionRule').mockImplementation(async (...args) => {
    const result = await originalRule(...args);
    saved ??= result;
    return result;
  });
  const assertClosed = observeBindings(() => {
    // Fault the earlier observation, retaining the original native binding and its provenance.
    Object.assign(saved!, { sourceGeneration: String(BigInt(saved!.sourceGeneration) + 1n) });
  });
  await expect(members()).rejects.toMatchObject({ code: 'dependency_unavailable' });
  assertClosed();
}, 120_000);

test('a page failure after binding preserves the error and closes the binding', async () => {
  const assertClosed = observeBindings();
  const failure = new Error('saved page snapshot failed');
  spyOn(plans, 'readBoundOwnerFilterPage').mockRejectedValueOnce(failure);
  await expect(members()).rejects.toBe(failure);
  assertClosed();
}, 120_000);

test('current final authority refusal closes both saved Members times', async () => {
  const assertClosed = observeBindings();
  let finalTime: command.AuthoritativeTime | undefined;
  let calls = 0;
  spyOn(rules, 'prepareCollectionRuleAuthority').mockImplementation((deps, viewer, filter, attempt, deadline) => {
    if (++calls === 2) {
      finalTime = attempt.time;
      // Exercise the installed scope refusal after actual native page execution.
      return originalPrepare(deps, reduced, filter, attempt, deadline);
    }
    return originalPrepare(deps, viewer, filter, attempt, deadline);
  });
  await expect(members()).rejects.toMatchObject({ code: 'forbidden' });
  expect(finalTime).toBeDefined();
  closed(finalTime!);
  assertClosed();
}, 120_000);

for (const outcome of ['success', 'first snapshot failure', 'final snapshot failure', 'authority refusal'] as const) {
  test(`publication status closes its owned time: ${outcome}`, async () => {
    const times: command.AuthoritativeTime[] = [];
    spyOn(command, 'mintReadTime').mockImplementation(async (...args) => {
      const time = await originalMint(...args);
      times.push(time);
      return time;
    });
    const release = spyOn(command, 'releaseOperationalTime');
    const failure = new Error(outcome);
    if (outcome.includes('snapshot')) {
      let snapshots = 0;
      spyOn(episodes, 'readCollectionPublicationEpisode').mockImplementation((...args) => {
        if (++snapshots === (outcome.startsWith('first') ? 1 : 2)) throw failure;
        return originalEpisode(...args);
      });
    }
    const result = service().status(outcome === 'authority refusal' ? reduced : actor, publicationId);
    if (outcome === 'success')
      expect(await result).toEqual({ id: publicationId, collectionId, visibility: 'public', phase: 'staging' });
    else if (outcome === 'authority refusal') await expect(result).rejects.toMatchObject({ code: 'forbidden' });
    else await expect(result).rejects.toBe(failure);
    expect(times).toHaveLength(1);
    closed(times[0]!);
    expect(release.mock.calls.filter(([value]) => value === times[0])).toHaveLength(1);
  }, 120_000);
}
