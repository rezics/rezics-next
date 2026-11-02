import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry } from '@rezics/composition';
import { loadSubjectPage, subjectAccountRedirect } from '../src/features/pages/subject';

const subject = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const account = '0192f3a0-6c1e-7b2a-f001-000000000002';
const foreign = '0192f3a0-6c1e-7b2a-f001-000000000003';
const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const context = { id: subject, population: { kind: 'realm' as const, id: realm, title: 'Selected' } };
const profile = { id: account, handle: 'current_name', state: 'active' };
const document = {
  root: { props: {} },
  content: ['SubjectHeader', 'AccountIdentity'].map((type) => ({ type, props: { id: type } })),
};
function page(body: unknown = { accounts: [profile] }) {
  const plan = planReads(platformRegistry, document, { subject, account: { id: account, handle: profile.handle } });
  return {
    subject,
    account,
    context,
    profile: 'published',
    template: { scope: 'type', key: 'schema:Person' },
    document,
    reads: Object.fromEntries(
      Object.entries(plan.reads).map(([key, read]) => [
        key,
        {
          status: 200,
          body: read.kind === 'account' ? body : { subject: { id: subject }, related: {} },
        },
      ]),
    ),
  };
}
async function load(body: unknown, status = 200, selectedRealm?: string) {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(body, { status });
    }) as typeof fetch,
  });
  try {
    return await loadSubjectPage(client, subject, 'details', 'ja', { realm: selectedRealm });
  } finally {
    expect(requests).toHaveLength(1);
    expect(requests[0]!.redirect).toBe('manual');
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/pages:read');
    expect(await requests[0]!.json()).toEqual({
      target: { subject, view: 'details', ...(selectedRealm ? { realm: selectedRealm } : {}) },
      languages: ['ja'],
    });
  }
}

test('the planned active account profile redirects by its handle, bound by immutable ID', async () => {
  expect(await load(page())).toEqual({ kind: 'redirect', id: profile.handle, target: 'account' });
  const global = page();
  Reflect.deleteProperty(global, 'context');
  expect(await load(global, 200, realm)).toEqual({ kind: 'redirect', id: profile.handle, target: 'account' });
});

test('foreign, inactive, absent and handleless profiles retain the catalogue identity and selected Realm', async () => {
  for (const body of [
    { accounts: [{ ...profile, id: foreign }] },
    { accounts: [{ ...profile, state: 'deleted' }] },
    { accounts: [{ ...profile, handle: null }] },
    { accounts: [] },
    {},
    { accounts: [{ ...profile, id: foreign }, profile] },
  ]) {
    const raw = page(body);
    expect(await load(raw, 200, realm)).toEqual({
      kind: 'page',
      page: { ...raw, account: undefined, requestedRealm: realm },
    });
  }
});

test('only a successful planned account slot supplies the redirect', async () => {
  for (const status of [404, 503]) {
    const raw = page();
    raw.reads.r1!.status = status;
    // A matching profile in another kind of read or an unplanned slot is not authority.
    raw.reads.r0!.body = { accounts: [profile] };
    raw.reads.unplanned = { status: 200, body: { accounts: [profile] } };
    expect(await load(raw)).toMatchObject({ kind: 'page', page: { subject } });
  }
  const raw = page();
  delete raw.reads.r1;
  expect(await load(raw)).toMatchObject({ kind: 'page', page: { subject } });
});

test('a malformed identity or missing Realm cannot silently select another catalogue page', async () => {
  for (const id of [null, '', foreign, undefined]) {
    const raw = { ...page({ accounts: [] }), subject: id };
    await expect(load(raw)).rejects.toMatchObject({ status: 503, message: 'dependency_unavailable' });
  }
  const raw = page({ accounts: [{ ...profile, id: foreign }] });
  Reflect.deleteProperty(raw, 'context');
  await expect(load(raw, 200, realm)).rejects.toMatchObject({ status: 503, message: 'dependency_unavailable' });
  expect(await load({ ...page({ accounts: [{ ...profile, id: '' }] }), account: '' })).toMatchObject({
    kind: 'page',
    page: { subject },
  });
});

test('native canonical redirects, merges, missing and unavailable outcomes retain their meaning', async () => {
  expect(await load({ redirect: { from: subject, to: profile.handle } }, 308)).toEqual({
    kind: 'redirect',
    id: profile.handle,
    target: 'account',
  });
  expect(subjectAccountRedirect('ja', profile.handle, 'details', '?realm=selected')).toEqual({
    href: `/ja/@${profile.handle}/details?realm=selected`,
    statusCode: 308,
  });
  const merged = { ...page(), subject: foreign };
  Reflect.deleteProperty(merged, 'account');
  expect(await load(merged)).toEqual({ kind: 'redirect', id: foreign });
  expect(await load({}, 404)).toEqual({ kind: 'missing' });
  await expect(load({ code: 'dependency_unavailable' }, 503)).rejects.toMatchObject({ status: 503 });
});
