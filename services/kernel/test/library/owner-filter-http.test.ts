import { expect, test } from 'bun:test';
import { createOwnerFilterFixture, ownerStatus } from './support/owner-filter-fixture.ts';

test('common members execute all five owner leaves and refuse catalogue composition without query acknowledgement', async () => {
  const f = await createOwnerFilterFixture();
  try {
    const { subjects: s, leaves: q } = f;
    const sorted = (...ids: string[]) => ids.sort();
    expect(await f.members(q.presence)).toEqual(sorted(s.entry.id, s.labelOnly.id, s.sessionOnly.id, s.copyOnly.id));
    expect(await f.members(q.state)).toEqual([s.entry.id]);
    expect(await f.members(q.label)).toEqual([s.labelOnly.id]);
    expect(await f.members(q.session)).toEqual([s.sessionOnly.id]);
    expect(await f.members(q.holding)).toEqual([s.copyOnly.id]);
    expect(await f.members(q.qualifiedHolding)).toEqual([s.copyOnly.id]);
    expect(await f.members({ not: q.state })).toEqual(
      sorted(s.labelOnly.id, s.sessionOnly.id, s.copyOnly.id, s.noEntry.id),
    );
    ownerStatus(
      await f.native.request('alice', 'GET', f.path({
        and: [{ type: { in: [f.type] } }, { or: [q.state, q.label, q.session, q.holding] }, { not: q.session }],
      })),
      503,
    );
    // Bob's completion must not exclude Alice's complete no-entry control.
    expect(await f.members({ not: q.session })).toContain(s.noEntry.id);
    expect(await f.members(q.label, 'bob')).toEqual([]);
    expect(await f.members(q.presence, 'bob')).toEqual([s.noEntry.id]);
  } finally {
    await f.close();
  }
}, 180_000);

test('owner-filter HTTP denies anonymous and reduced scopes in every Boolean branch and rejects unsupported operators', async () => {
  const f = await createOwnerFilterFixture();
  try {
    const query = { or: [{ type: { in: [f.type] } }, f.leaves.session] };
    ownerStatus(await f.native.request('anonymous', 'GET', f.path(query)), 401);
    const reduced = await f.native.scoped('alice', ['collection:read', 'subject:read', 'library_entry:list']);
    const response = await reduced.request('GET', f.path(query));
    ownerStatus(response, 403);
    expect(response.headers.get('www-authenticate')).toContain('insufficient_scope');
    for (const filter of [
      { owner: { presence: false } },
      { owner: { accountId: f.native.personas.bob.accountId, presence: true } },
      { owner: { unsupported: true } },
    ]) {
      const invalid = await f.native.request(
        'alice',
        'GET',
        `/v1/collections/${f.collectionId}/members?${new URLSearchParams({
          filter: JSON.stringify(filter),
          sort: 'id',
        })}`,
      );
      expect([400, 422]).toContain(invalid.status);
    }
    const suspended = await f.native.request('suspended', 'GET', f.path(f.leaves.presence));
    ownerStatus(suspended, 401);
    expect(suspended.body.code).toBe('invalid_credentials');
    expect(suspended.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  } finally {
    await f.close();
  }
}, 180_000);
