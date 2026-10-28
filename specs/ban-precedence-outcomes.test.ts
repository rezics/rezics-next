import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BAN_PRECEDENCE_MISSING_DRIVER,
  type BanPrecedenceDriver,
  type BanPrecedenceFixture,
  type Credential,
  type GrantKind,
  type ReadProbe,
  type ReadSurface,
} from './ban-precedence-driver.ts';

setDefaultTimeout(240_000);
let driver: BanPrecedenceDriver | undefined;
beforeEach(async () => {
  const location = process.env.BAN_PRECEDENCE_DRIVER;
  if (!location) throw new Error(BAN_PRECEDENCE_MISSING_DRIVER);
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('BAN_PRECEDENCE_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('BAN_PRECEDENCE_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createBanPrecedenceDriver !== 'function')
    throw new Error('Expected createBanPrecedenceDriver factory');
  driver = await binding.createBanPrecedenceDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});
const native = () => driver!;
const reason = 'private-ban-reason-not-for-read-responses';
const probes = (surface: ReadSurface): ReadProbe[] => Object.values(surface);
const bearer = (f: BanPrecedenceFixture, kind: GrantKind) => (kind === 'delegation' ? f.delegate : f.member).credential;

async function command(response: Response) {
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
}
async function readable(credential: Credential | null, probe: ReadProbe) {
  const response = await native().request(credential, probe.path);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const body = await response.json();
  expect(probe.marker.length).toBeGreaterThan(0);
  expect(JSON.stringify(body)).toContain(probe.marker);
  expect(JSON.stringify(body)).not.toContain(reason);
  expect(JSON.stringify([...response.headers])).not.toContain(reason);
  return {
    body,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    etag: response.headers.get('etag'),
    vary: response.headers.get('vary'),
  };
}
async function refusal(credential: Credential | null, probe: ReadProbe, secrets: string[] = []) {
  const response = await native().request(credential, probe.path);
  expect([403, 404]).toContain(response.status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const text = await response.text();
  const code = response.status === 404 ? 'not_found' : 'forbidden';
  const body = JSON.parse(text);
  expect(body).toMatchObject({
    status: response.status,
    code,
    type: `https://rezics.com/problems/${code}`,
    retryable: false,
    effect_status: 'not_applicable',
  });
  expect(typeof body.request_id).toBe('string');
  const { request_id: _request, ...stable } = body;
  // No success payload, items, counts, cursor, partial-page flag or ban metadata.
  expect(
    Object.keys(stable).every((key) =>
      ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'detail', 'errors'].includes(key),
    ),
  ).toBe(true);
  const wire = `${text}\n${JSON.stringify([...response.headers])}`;
  for (const secret of [reason, ...secrets]) expect(wire).not.toContain(secret);
  return stable;
}
async function granted(kind: GrantKind) {
  const f = await native().fixture();
  await command(await native().grantRead(f, kind));
  const credential = bearer(f, kind);
  for (const probe of probes(f.privateReads)) await readable(credential, probe);
  return { f, credential };
}
async function ban(f: BanPrecedenceFixture) {
  await command(await native().ban(f, reason));
}
async function privateDenied(f: BanPrecedenceFixture, credential: Credential) {
  const secrets = probes(f.privateReads).map((probe) => probe.marker);
  for (const probe of probes(f.privateReads)) {
    // Same route's ordinary no-grant refusal, not a ban-specific error contract.
    const ordinary = await refusal(f.outsider.credential, probe, secrets);
    expect(await refusal(credential, probe, secrets)).toEqual(ordinary);
  }
}

test("a member banned from a Realm who also holds an independent direct read grant on one of its boards is refused that board's private reads on the next request with the same bearer", async () => {
  const { f, credential } = await granted('direct');
  await ban(f);
  await privateDenied(f, credential);
});

test('the same holds for a grant through an organization and for a delegated agent acting for the banned member', async () => {
  for (const kind of ['organization', 'delegation'] as const) {
    const { f, credential } = await granted(kind);
    await ban(f);
    await privateDenied(f, credential);
  }
});

test('a public Realm resource stays readable to the banned member exactly as it is to an anonymous reader', async () => {
  for (const kind of ['direct', 'organization', 'delegation'] as const) {
    const { f, credential } = await granted(kind);
    const before = [];
    for (const probe of probes(f.publicReads)) before.push(await readable(null, probe));
    await ban(f);
    for (const [index, probe] of probes(f.publicReads).entries()) {
      const anonymous = await readable(null, probe);
      expect(anonymous).toEqual(before[index]);
      expect(await readable(f.member.credential, probe)).toEqual(anonymous);
      expect(await readable(credential, probe)).toEqual(anonymous);
    }
  }
});

test("lifting the ban restores the independent grant's reads on the next request", async () => {
  for (const kind of ['direct', 'organization', 'delegation'] as const) {
    const { f, credential } = await granted(kind);
    const before = [];
    for (const probe of probes(f.privateReads)) before.push(await readable(credential, probe));
    await ban(f);
    await privateDenied(f, credential);
    await command(await native().lift(f));
    for (const [index, probe] of probes(f.privateReads).entries())
      expect(await readable(credential, probe)).toEqual(before[index]);
  }
});

test('the ban never discloses itself to other readers', async () => {
  const { f } = await granted('direct');
  const publicBefore = [];
  const privateBefore = [];
  const deniedBefore = [];
  for (const credential of [null, f.outsider.credential, f.reader.credential]) {
    for (const probe of probes(f.publicReads)) publicBefore.push(await readable(credential, probe));
  }
  for (const probe of probes(f.privateReads)) {
    privateBefore.push(await readable(f.reader.credential, probe));
    for (const credential of [null, f.outsider.credential]) deniedBefore.push(await refusal(credential, probe));
  }
  await ban(f);
  let index = 0;
  for (const credential of [null, f.outsider.credential, f.reader.credential]) {
    for (const probe of probes(f.publicReads)) expect(await readable(credential, probe)).toEqual(publicBefore[index++]);
  }
  index = 0;
  for (const probe of probes(f.privateReads))
    expect(await readable(f.reader.credential, probe)).toEqual(privateBefore[index++]);
  index = 0;
  for (const probe of probes(f.privateReads)) {
    for (const credential of [null, f.outsider.credential])
      expect(await refusal(credential, probe)).toEqual(deniedBefore[index++]);
  }
});

test("a banned member's own past posts stay as their visibility rules say", async () => {
  const { f, credential } = await granted('direct');
  const publicBefore = await readable(null, f.pastPosts.public);
  const privateBefore = await readable(f.reader.credential, f.pastPosts.private);
  await readable(credential, f.pastPosts.private);
  await ban(f);
  for (const reader of [null, credential, f.reader.credential, f.outsider.credential])
    expect(await readable(reader, f.pastPosts.public)).toEqual(publicBefore);
  expect(await readable(f.reader.credential, f.pastPosts.private)).toEqual(privateBefore);
  const ordinary = await refusal(f.outsider.credential, f.pastPosts.private);
  expect(await refusal(credential, f.pastPosts.private, [f.pastPosts.private.marker])).toEqual(ordinary);
});

test('every refusal is the ordinary not_found or forbidden answer of that read with no partial page', async () => {
  for (const kind of ['direct', 'organization', 'delegation'] as const) {
    const { f, credential } = await granted(kind);
    await ban(f);
    await privateDenied(f, credential);
  }
});
