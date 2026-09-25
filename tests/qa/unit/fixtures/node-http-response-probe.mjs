import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { test } from 'node:test';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
assert.equal(process.version, 'v26.8.2', 'run the pinned Node version');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Node HTTP response probe timed out')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function openProbe(body, gated = false) {
  const request = deferred();
  const finish = deferred();
  const close = deferred();
  const events = [];
  const server = createServer((_req, response) => {
    response.on('finish', () => {
      events.push('finish');
      finish.resolve();
    });
    response.on('close', () => {
      events.push('close');
      close.resolve();
    });
    response.writeHead(200, {
      'content-length': body.length,
      'content-type': 'application/octet-stream',
      connection: 'close',
    });
    if (gated) response.write(body.subarray(0, 16));
    else response.end(body);
    request.resolve(response);
  });
  server.listen(0, HOST);
  await within(new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  }));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = createConnection({ host: HOST, port: address.port });
  client.on('error', () => {});
  await within(new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  }));
  return {
    client, server, request: request.promise, finish: finish.promise,
    close: close.promise, events,
    sendRequest() {
      client.write('GET /probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    },
    async dispose() {
      client.destroy();
      server.closeAllConnections();
      await within(new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    },
  };
}

function readResponse(client) {
  const chunks = [];
  const ended = new Promise((resolve, reject) => {
    client.on('data', (chunk) => chunks.push(chunk));
    client.once('end', resolve);
    client.once('error', reject);
  });
  return within(ended).then(() => Buffer.concat(chunks));
}

function bodyFromHttp(bytes) {
  const separator = bytes.indexOf('\r\n\r\n');
  assert(separator >= 0, 'HTTP headers must be complete');
  return bytes.subarray(separator + 4);
}

test('SEARCH12 Node 26 HTTP normal response finishes after complete server send', async () => {
  const body = Buffer.from('sensitive-result');
  const probe = await openProbe(body);
  try {
    const received = readResponse(probe.client);
    probe.sendRequest();
    await within(probe.request);
    await within(probe.finish);
    assert.equal(probe.events[0], 'finish');
    assert.deepEqual(bodyFromHttp(await received), body);
    await within(probe.close);
  } finally { await probe.dispose(); }
});

test('SEARCH12 Node 26 HTTP finish precedes a paused client application read', async () => {
  const body = Buffer.from('sensitive-result');
  const probe = await openProbe(body);
  try {
    probe.client.pause();
    let dataCallbacks = 0;
    probe.client.on('data', () => { dataCallbacks += 1; });
    probe.sendRequest();
    await within(probe.finish);
    assert.equal(dataCallbacks, 0);
    const received = readResponse(probe.client);
    probe.client.resume();
    assert.deepEqual(bodyFromHttp(await received), body);
    assert(dataCallbacks > 0);
  } finally { await probe.dispose(); }
});

test('SEARCH12 Node 26 HTTP premature close does not certify finish', async () => {
  const probe = await openProbe(Buffer.alloc(MAX_BODY_BYTES, 0x78), true);
  try {
    probe.sendRequest();
    const response = await within(probe.request);
    probe.client.destroy();
    await within(probe.close);
    assert.equal(probe.events.includes('finish'), false);
    assert.equal(response.writableFinished, false);
  } finally { await probe.dispose(); }
});

test('SEARCH12 Node 26 HTTP maximum 1 MiB body reaches finish before paused client read', async () => {
  const body = Buffer.alloc(MAX_BODY_BYTES, 0x78);
  const probe = await openProbe(body);
  try {
    probe.client.pause();
    let dataCallbacks = 0;
    probe.client.on('data', () => { dataCallbacks += 1; });
    probe.sendRequest();
    await within(probe.finish);
    assert.equal(dataCallbacks, 0);
    const received = readResponse(probe.client);
    probe.client.resume();
    assert.deepEqual(bodyFromHttp(await received), body);
    assert(dataCallbacks > 0);
  } finally { await probe.dispose(); }
});
