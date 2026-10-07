import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { fetchWebSnapshot } from '../src/modules/web-publication/fetch.ts';
import {
  SnapshotRightsDenied,
  SnapshotRobotsDenied,
  WEB_SNAPSHOT_COST,
  WebSnapshotUnavailable,
} from '../src/modules/web-publication/schema.ts';
import {
  SafeSnapshotTransport,
  SNAPSHOT_USER_AGENT,
  type SnapshotAddress,
  type SnapshotResolver,
} from '../src/modules/web-publication/transport.ts';

const target = new URL('https://capture.example/story?chapter=1');
const publicV4 = { address: '93.184.216.34', family: 4 };
const publicV6 = { address: '2606:4700:4700::1111', family: 6 };

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  stall?: boolean;
  fail?: boolean;
}
function network(resolve: SnapshotResolver, replies: Reply[] = [{}]) {
  const calls: { url: URL; options: RequestOptions; pinned: SnapshotAddress[] }[] = [];
  const request = ((
    url: URL,
    options: RequestOptions,
    receive: (response: IncomingMessage) => void,
  ) => {
    const reply = replies[calls.length] ?? {};
    const call = { url, options, pinned: [] as SnapshotAddress[] };
    calls.push(call);
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.destroy = (() => outgoing) as ClientRequest['destroy'];
    outgoing.end = (() => {
      queueMicrotask(() => {
        const lookup = options.lookup!;
        lookup(url.hostname, { all: true }, (_error, addresses) => {
          call.pinned.push(...(addresses as SnapshotAddress[]));
        });
        lookup(url.hostname, {}, (_error, address, family) => {
          call.pinned.push({ address: address as string, family: family! });
        });
        const incoming = new Readable({ read() {} }) as IncomingMessage;
        incoming.statusCode = reply.status ?? 200;
        incoming.headers = reply.headers ?? { 'content-type': 'Text/Plain; charset=utf-8' };
        const abort = () => {
          outgoing.emit('error', new Error('request aborted'));
          incoming.destroy(new Error('body aborted'));
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        incoming.on('close', () => options.signal?.removeEventListener('abort', abort));
        receive(incoming);
        if (reply.fail) incoming.destroy(new Error('partial response'));
        else if (!reply.stall) {
          for (const chunk of reply.chunks ?? [Buffer.from('page')]) incoming.push(chunk);
          incoming.push(null);
        }
      });
      return outgoing;
    }) as ClientRequest['end'];
    return outgoing;
  }) as typeof httpsRequest;
  return { calls, transport: new SafeSnapshotTransport({ resolve, request }) };
}

const nonPublic = [
  '0.0.0.0',
  '10.1.2.3',
  '100.64.0.1',
  '100.127.255.254',
  '127.0.0.2',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.254',
  '192.0.0.8',
  '192.0.2.1',
  '192.88.99.1',
  '192.168.1.1',
  '198.18.0.1',
  '198.19.255.254',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  'fc00::1',
  'fd00::1',
  'fe80::1',
  'ff02::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:10.0.0.1',
  '64:ff9b::a00:1',
  '64:ff9b:1::1',
  '100::1',
  '2001::1',
  '2001:2::1',
  '2001:db8::1',
  '2001:0db8:0000:0000:0000:0000:0000:0001',
  '2002:0a00:0001::1',
  '3fff::1',
  '3fff:0fff::1',
  '5f00::1',
];

test('rights denial prevents even destination DNS resolution', async () => {
  let lookups = 0;
  const fake = network(async () => {
    lookups++;
    return [publicV4];
  });
  await expect(
    fetchWebSnapshot(target.href, {
      transport: fake.transport,
      rightsPermitted: async () => false,
    }),
  ).rejects.toBeInstanceOf(SnapshotRightsDenied);
  expect(lookups).toBe(0);
  expect(fake.calls).toHaveLength(0);
});

test('a denied DNS answer does not prevent a later public-address retry', async () => {
  let lookups = 0;
  const fake = network(async () => [
    ++lookups === 1 ? { address: '10.0.0.1', family: 4 } : publicV4,
  ]);
  await expect(fake.transport.get(target, null)).rejects.toBeInstanceOf(WebSnapshotUnavailable);
  expect(fake.calls).toHaveLength(0);
  expect((await fake.transport.get(target, null)).bytes.toString()).toBe('page');
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.pinned).toEqual([publicV4, publicV4]);
});

test('simultaneous requests each pin their own DNS observation', async () => {
  let lookups = 0;
  const fake = network(async () => [++lookups === 1 ? publicV4 : publicV6]);
  await Promise.all([fake.transport.get(target, null), fake.transport.get(target, null)]);
  expect(lookups).toBe(2);
  expect(fake.calls.map((call) => call.pinned)).toEqual([
    [publicV4, publicV4],
    [publicV6, publicV6],
  ]);
});

test.each(nonPublic)(
  'private/special literal %s is rejected before DNS or HTTPS',
  async (address) => {
    let lookups = 0;
    const fake = network(async () => {
      lookups++;
      return [publicV4];
    });
    const host = address.includes(':') ? `[${address}]` : address;
    await expect(fake.transport.get(new URL(`https://${host}/story`), null)).rejects.toBeInstanceOf(
      WebSnapshotUnavailable,
    );
    expect(lookups).toBe(0);
    expect(fake.calls).toHaveLength(0);
  },
);

test.each(nonPublic)('hostname DNS answer %s is rejected before HTTPS', async (address) => {
  const fake = network(async () => [{ address, family: address.includes(':') ? 6 : 4 }]);
  await expect(fake.transport.get(target, null)).rejects.toBeInstanceOf(WebSnapshotUnavailable);
  expect(fake.calls).toHaveLength(0);
});

test.each(
  [
    [],
    [publicV4, { address: '10.0.0.1', family: 4 }],
    [publicV6, { address: '::1', family: 6 }],
    [{ address: 'not-an-address', family: 4 }],
    [{ address: publicV4.address, family: 6 }],
    [{ address: 'fe80::1%eth0', family: 6 }],
  ].map((addresses) => ({ addresses })),
)(
  'all answers must be valid public addresses with matching families: %j',
  async ({ addresses }) => {
    const fake = network(async () => addresses);
    await expect(fake.transport.get(target, null)).rejects.toBeInstanceOf(WebSnapshotUnavailable);
    expect(fake.calls).toHaveLength(0);
  },
);

test.each([
  'http://127.0.0.1/story',
  'http://capture.example/story',
  'https://user:secret@capture.example/story',
  'https://2130706433/story',
  'https://0x7f000001/story',
  'https://127.1/story',
])('unsafe URL %s sends zero requests', async (url) => {
  const fake = network(async () => [publicV4]);
  await expect(
    fetchWebSnapshot(url, { transport: fake.transport, rightsPermitted: async () => true }),
  ).rejects.toBeInstanceOf(WebSnapshotUnavailable);
  expect(fake.calls).toHaveLength(0);
});

test('each request pins its checked DNS answer while retaining the HTTPS hostname', async () => {
  let lookups = 0;
  const fake = network(
    async () => (++lookups === 1 ? [publicV4, publicV6] : [publicV6]),
    [{ status: 404, chunks: [] }, { chunks: [Buffer.from('星港'), Buffer.from('夜話')] }],
  );
  const captured = await fetchWebSnapshot(target.href, {
    transport: fake.transport,
    rightsPermitted: async (origin) => origin === target.origin,
    now: () => new Date('2024-03-01T00:00:00Z'),
  });
  expect(captured).toEqual({
    bytes: Buffer.from('星港夜話'),
    mediaType: 'text/plain',
    fetchedAt: '2024-03-01T00:00:00.000Z',
  });
  expect(lookups).toBe(2);
  expect(fake.calls.map((call) => call.url.href)).toEqual([
    'https://capture.example/robots.txt',
    target.href,
  ]);
  expect(fake.calls.map((call) => call.pinned)).toEqual([
    [publicV4, publicV4],
    [publicV6, publicV6],
  ]);
  for (const call of fake.calls) {
    expect(call.options.agent).toBe(false);
    expect(call.options.family).toBe(call.pinned[0]!.family);
    expect(call.options.headers).toMatchObject({ 'user-agent': SNAPSHOT_USER_AGENT });
    expect(call.options.maxHeaderSize).toBe(16_384);
  }
  expect(fake.calls[0]!.options.headers).toMatchObject({ accept: 'text/plain' });
});

test('DNS rebinding between robots and page refuses the page socket', async () => {
  let lookups = 0;
  const fake = network(
    async () => [++lookups === 1 ? publicV4 : { address: '10.0.0.1', family: 4 }],
    [{ status: 404, chunks: [] }],
  );
  await expect(
    fetchWebSnapshot(target.href, { transport: fake.transport, rightsPermitted: async () => true }),
  ).rejects.toBeInstanceOf(WebSnapshotUnavailable);
  expect(lookups).toBe(2);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.pinned).toEqual([publicV4, publicV4]);
});

test.each([301, 302, 303, 307, 308])(
  'redirect %i is refused without another request',
  async (status) => {
    const fake = network(
      async () => [publicV4],
      [{ status, headers: { location: 'https://10.0.0.1/' } }],
    );
    await expect(
      fetchWebSnapshot(target.href, {
        transport: fake.transport,
        rightsPermitted: async () => true,
      }),
    ).rejects.toBeInstanceOf(WebSnapshotUnavailable);
    expect(fake.calls).toHaveLength(1);
  },
);

test('robots denial and unavailable robots stop before acquiring the page', async () => {
  for (const status of [200, 403]) {
    const fake = network(
      async () => [publicV4],
      [{ status, chunks: [Buffer.from('User-agent: *\nDisallow: /story\n')] }],
    );
    await expect(
      fetchWebSnapshot(target.href, {
        transport: fake.transport,
        rightsPermitted: async () => true,
      }),
    ).rejects.toBeInstanceOf(status === 200 ? SnapshotRobotsDenied : WebSnapshotUnavailable);
    expect(fake.calls).toHaveLength(1);
  }
});

test('both declared and streamed byte bounds apply, while the exact bound succeeds', async () => {
  for (const reply of [
    { headers: { 'content-length': String(WEB_SNAPSHOT_COST.maxBytes + 1) } },
    { headers: { 'content-length': 'invalid' } },
    { chunks: [Buffer.alloc(WEB_SNAPSHOT_COST.maxBytes), Buffer.from('x')] },
  ]) {
    const fake = network(async () => [publicV4], [reply]);
    await expect(fake.transport.get(target, null)).rejects.toBeInstanceOf(WebSnapshotUnavailable);
  }
  const fake = network(
    async () => [publicV4],
    [{ chunks: [Buffer.alloc(WEB_SNAPSHOT_COST.maxBytes)] }],
  );
  expect((await fake.transport.get(target, null)).bytes.length).toBe(WEB_SNAPSHOT_COST.maxBytes);
});

test('DNS failure and interrupted bodies fail closed', async () => {
  const dns = network(async () => {
    throw new Error('DNS failed');
  });
  await expect(dns.transport.get(target, null)).rejects.toBeInstanceOf(WebSnapshotUnavailable);
  expect(dns.calls).toHaveLength(0);
  const body = network(async () => [publicV4], [{ fail: true }]);
  await expect(body.transport.get(target, null)).rejects.toBeInstanceOf(WebSnapshotUnavailable);
});

test('the request deadline includes DNS without creating a socket', async () => {
  let release!: (addresses: SnapshotAddress[]) => void;
  const fake = network(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await expect(fake.transport.get(target, null)).rejects.toBeInstanceOf(WebSnapshotUnavailable);
  release([publicV4]);
  await Promise.resolve();
  expect(fake.calls).toHaveLength(0);
}, 10_000);

test('the request deadline aborts a stalled response body', async () => {
  const fake = network(async () => [publicV4], [{ stall: true }]);
  await expect(fake.transport.get(target, null)).rejects.toBeInstanceOf(WebSnapshotUnavailable);
  expect(fake.calls[0]!.options.signal?.aborted).toBe(true);
}, 10_000);
