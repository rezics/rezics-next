import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import {
  McpCancelled,
  McpProtocolClient,
  McpProtocolError,
  SafeMcpTransport,
  type McpTransportRequest,
} from '../src/modules/connected-apps/protocol.ts';

interface Address {
  address: string;
  family: number;
}
const target = 'https://mcp.example/tools';
const publicV4 = { address: '93.184.216.34', family: 4 };
const publicV6 = { address: '2606:4700:4700::1111', family: 6 };
const request: McpTransportRequest = {
  method: 'POST',
  headers: { authorization: 'Bearer fixture' },
  body: Buffer.from('{}'),
};

function network(
  resolve: (host: string) => Promise<Address[]>,
  reply: {
    status?: number;
    headers?: Record<string, string>;
    fail?: boolean;
  } = {},
) {
  const calls: { url: URL; options: RequestOptions; pinned: Address[]; body?: Buffer }[] = [];
  const send = ((
    url: URL,
    options: RequestOptions,
    receive: (incoming: IncomingMessage) => void,
  ) => {
    const call = { url, options, pinned: [] as Address[], body: undefined as Buffer | undefined };
    calls.push(call);
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.end = ((body: Buffer) => {
      call.body = body;
      queueMicrotask(() => {
        options.lookup!(url.hostname, { all: true }, (_error, addresses) => {
          call.pinned.push(...(addresses as Address[]));
        });
        options.lookup!(url.hostname, {}, (_error, address, family) => {
          call.pinned.push({ address: address as string, family: family! });
        });
        const incoming = new Readable({ read() {} }) as IncomingMessage;
        incoming.statusCode = reply.status ?? 200;
        incoming.headers = reply.headers ?? { 'content-type': 'application/json' };
        receive(incoming);
        incoming.push(Buffer.from('{}'));
        if (reply.fail) incoming.destroy(new Error('partial response'));
        else incoming.push(null);
      });
      return outgoing;
    }) as ClientRequest['end'];
    return outgoing;
  }) as typeof httpsRequest;
  return { calls, transport: new SafeMcpTransport({ resolve, request: send }) };
}

const nonPublic = [
  '0.0.0.0',
  '10.1.2.3',
  '100.64.0.0',
  '100.127.255.255',
  '127.0.0.2',
  '169.254.169.254',
  '172.16.0.0',
  '172.31.255.255',
  '192.0.0.8',
  '192.0.0.9',
  '192.0.2.1',
  '192.88.99.1',
  '192.168.1.1',
  '198.18.0.0',
  '198.19.255.255',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '0000:0000:0000:0000:0000:0000:0000:0001',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:10.0.0.1',
  '::ffff:8.8.8.8',
  '0000:0000:0000:0000:0000:ffff:0808:0808',
  '64:ff9b::a00:1',
  '64:ff9b:1::1',
  '100::1',
  '100:0:0:1::1',
  '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  '2001::1',
  '2001:0000:0000:0000:0000:0000:0000:0001',
  '2001:1::1',
  '2001:2::1',
  '2001:3::1',
  '2001:4:112::1',
  '2001:10::1',
  '2001:20::1',
  '2001:30::1',
  '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
  '2001:db8::1',
  '2001:0DB8:0000:0000:0000:0000:0000:0001',
  '2001:0db8::192.168.1.1',
  '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
  '2002:0a00:0001::1',
  '2002:c0a8:0101:0000:0000:0000:0000:0001',
  '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  '3fff::1',
  '3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff',
  '4000::1',
  '5f00::1',
  'fc00::1',
  'fd00::1',
  'fd00:0000:0000:0000:0000:0000:0000:0001',
  'fe80::1',
  'fe80:0000:0000:0000:0000:0000:0000:0001',
  'ff02::1',
];

test.each(nonPublic)('non-public literal %s is refused before DNS or HTTPS', async (address) => {
  let lookups = 0;
  const fake = network(async () => {
    lookups++;
    return [publicV4];
  });
  const host = isIP(address) === 6 ? `[${address}]` : address;
  await expect(fake.transport.send(`https://${host}/tools`, request)).rejects.toThrow(
    'non-public address',
  );
  expect(lookups).toBe(0);
  expect(fake.calls).toHaveLength(0);
});

// DNS preserves spelling, whereas URL parsing canonicalizes IPv6 literals.
test.each([...nonPublic, 'fe80::1%eth0', '2606:4700::1%eth0', 'not-an-address'])(
  'non-public DNS answer %s is refused before HTTPS',
  async (address) => {
    const fake = network(async () => [{ address, family: isIP(address) }]);
    await expect(fake.transport.send(target, request)).rejects.toThrow('non-public address');
    expect(fake.calls).toHaveLength(0);
  },
);

const publicAddresses = [
  '8.8.8.8',
  publicV4.address,
  '100.63.255.255',
  '100.128.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '192.0.1.1',
  '192.169.0.1',
  '198.17.255.255',
  '198.20.0.0',
  '223.255.255.255',
  '2000::1',
  '2001:200::1',
  '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
  '2001:db9::1',
  '2003::1',
  publicV6.address,
  '2606:4700:4700:0000:0000:0000:0000:1111',
  '2606:4700::8.8.8.8',
  '2620:4f:8000::1',
  '3ffe:ffff::1',
  '3fff:1000::1',
  '3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
];

test.each(publicAddresses)(
  'public address %s works through DNS and a literal URL',
  async (address) => {
    const answer = { address, family: isIP(address) };
    let lookups = 0;
    const fake = network(async () => {
      lookups++;
      return [answer];
    });
    expect((await fake.transport.send(target, request)).status).toBe(200);
    expect(fake.calls[0]!.pinned).toEqual([answer, answer]);
    const host = answer.family === 6 ? `[${address}]` : address;
    const endpoint = `https://${host}/tools`;
    expect((await fake.transport.send(endpoint, request)).status).toBe(200);
    const canonical = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    expect(fake.calls[1]!.pinned).toEqual([
      { address: canonical, family: answer.family },
      { address: canonical, family: answer.family },
    ]);
    expect(lookups).toBe(1);
  },
);

test.each(
  [
    [],
    [publicV4, { address: '2001:0db8::1', family: 6 }],
    [{ address: '2002:0a00:1::1', family: 6 }, publicV6],
    [publicV6, { address: '10.0.0.1', family: 4 }],
  ].map((addresses) => ({ addresses })),
)('every DNS answer must be public: %j', async ({ addresses }) => {
  const fake = network(async () => addresses);
  await expect(fake.transport.send(target, request)).rejects.toBeInstanceOf(McpProtocolError);
  expect(fake.calls).toHaveLength(0);
});

test('each concurrent request pins its observation and retains hostname, credentials and socket options', async () => {
  let lookups = 0;
  const fake = network(async () => (++lookups === 1 ? [publicV4, publicV6] : [publicV6]));
  await Promise.all([fake.transport.send(target, request), fake.transport.send(target, request)]);
  expect(lookups).toBe(2);
  expect(fake.calls.map((call) => call.pinned)).toEqual([
    [publicV4, publicV4],
    [publicV6, publicV6],
  ]);
  for (const call of fake.calls) {
    expect(call.url.href).toBe(target);
    expect(call.options).toMatchObject({ method: 'POST', agent: false, maxHeaderSize: 16_384 });
    expect(call.options.headers).toMatchObject({
      authorization: 'Bearer fixture',
      'content-length': '2',
    });
    expect(call.options.signal).toBeInstanceOf(AbortSignal);
    expect(call.body).toEqual(request.body);
  }
});

test('denial does not cache an address and a later public observation can recover', async () => {
  let lookups = 0;
  const fake = network(async () => [
    ++lookups === 1 ? { address: '2002:a00:1::1', family: 6 } : publicV6,
  ]);
  await expect(fake.transport.send(target, request)).rejects.toBeInstanceOf(McpProtocolError);
  expect(fake.calls).toHaveLength(0);
  expect((await fake.transport.send(target, request)).status).toBe(200);
  expect(lookups).toBe(2);
  expect(fake.calls[0]!.pinned).toEqual([publicV6, publicV6]);
});

test.each([301, 302, 303, 307, 308])(
  'redirect %i never forwards a second request',
  async (status) => {
    const fake = network(async () => [publicV4], {
      status,
      headers: { location: 'https://10.0.0.1/tools' },
    });
    await expect(
      new McpProtocolClient(fake.transport, target, 'fixture').observe(),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(fake.calls).toHaveLength(1);
  },
);

test('cancelled DNS, resolution failure and interrupted responses do not produce success', async () => {
  const controller = new AbortController();
  let finish!: (addresses: Address[]) => void;
  const cancelled = network(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = cancelled.transport.send(target, { ...request, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(McpCancelled);
  finish([publicV4]);
  await Promise.resolve();
  expect(cancelled.calls).toHaveLength(0);
  const failed = network(async () => {
    throw new Error('DNS failed');
  });
  await expect(failed.transport.send(target, request)).rejects.toThrow('DNS failed');
  expect(failed.calls).toHaveLength(0);
  const partial = network(async () => [publicV4], { fail: true });
  await expect(partial.transport.send(target, request)).rejects.toThrow('partial response');
});
