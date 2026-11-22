import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { once } from 'node:events';
import { isAutomationCommand, type AutomationRequest } from './automation-commands';
import { automationError, type AutomationResult } from './automation-types';
import { record } from './rpc-values';

const descriptorFile = 'automation.json';
const address = '127.0.0.1';
export const automationFrameLimit = 16 * 1024 * 1024;
const handshakeTimeout = 5000;
const unavailable = 'The running Launcher host did not answer the automation request.';

function signature(key: string, role: 'host' | 'client', nonce: string, body = '') {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(role).update(nonce).update(body).digest('hex');
}

function validSignature(expected: string, offered: unknown) {
  return (
    typeof offered === 'string' &&
    /^[0-9a-f]{64}$/u.test(offered) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(offered, 'hex'))
  );
}

function frame(value: unknown) {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded) > automationFrameLimit)
    throw new Error('This automation message is too large. Use a smaller batch.');
  return encoded;
}

function receive(socket: Socket, timeout?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = timeout === undefined ? undefined : setTimeout(closed, timeout).unref();
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('close', closed);
      socket.off('error', closed);
    }
    function closed() {
      cleanup();
      reject(new Error(unavailable));
    }
    function data(chunk: Buffer) {
      const newline = chunk.indexOf(10);
      const segment = newline < 0 ? chunk : chunk.subarray(0, newline);
      size += segment.length;
      if (size >= automationFrameLimit) {
        cleanup();
        reject(new Error('This automation message is too large. Use a smaller batch.'));
        return;
      }
      chunks.push(segment);
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      } catch {
        reject(new Error('Invalid Launcher automation message.'));
      }
    }
    socket.on('data', data);
    socket.once('close', closed);
    socket.once('error', closed);
  });
}

export async function listenForAutomation(
  directory: string,
  dispatch: (request: AutomationRequest, signal: AbortSignal) => Promise<AutomationResult>,
) {
  const key = randomBytes(32).toString('hex');
  const destination = join(directory, descriptorFile);
  const scratch = join(directory, `.automation-${randomUUID()}.tmp`);
  const commands = new Set<Promise<void>>();
  const closing = new AbortController();
  const server = createServer((socket) => {
    socket.on('error', () => {});
    const command = handle(socket);
    commands.add(command);
    void command.then(
      () => commands.delete(command),
      () => commands.delete(command),
    );
  });
  server.maxConnections = 8;
  server.on('error', () => {});

  async function handle(socket: Socket) {
    const disconnected = new AbortController();
    socket.once('close', () => disconnected.abort(new Error('The Launcher command disconnected.')));
    const signal = AbortSignal.any([closing.signal, disconnected.signal]);
    let result: { ok: true; result: AutomationResult } | { ok: false; error: string };
    try {
      const nonce = randomBytes(24).toString('hex');
      const incoming = receive(socket, handshakeTimeout);
      socket.write(frame({ nonce, proof: signature(key, 'host', nonce) }));
      const { body, proof } = record(await incoming);
      if (typeof body !== 'string' || !validSignature(signature(key, 'client', nonce, body), proof)) {
        throw new Error('Launcher automation authorization failed.');
      }
      signal.throwIfAborted();
      const { command, argument } = record(JSON.parse(body));
      if (!isAutomationCommand(command)) throw new Error('This command is unavailable through Launcher automation.');
      const value = await dispatch({ command, argument }, signal);
      result = { ok: true, result: value };
    } catch (error) {
      result = { ok: false, error: automationError(error) };
    }
    if (socket.destroyed) return;
    socket.setTimeout(handshakeTimeout, () => socket.destroy());
    try {
      socket.end(frame(result));
    } catch (error) {
      socket.end(frame({ ok: false, error: automationError(error) }));
    }
  }

  async function stop() {
    closing.abort(new Error('The Launcher host is closing.'));
    const stopped = new Promise<void>((done) => server.close(() => done()));
    await Promise.all([stopped, Promise.allSettled([...commands])]);
  }

  try {
    const listening = once(server, 'listening');
    server.listen(0, address);
    await listening;
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('Could not open the Launcher automation endpoint.');
    await writeFile(scratch, JSON.stringify({ version: 1, port: bound.port, key }), { mode: 0o600, flag: 'wx' });
    await rename(scratch, destination);
  } catch (error) {
    await stop();
    await rm(scratch, { force: true });
    throw error;
  }
  return async () => {
    await stop();
    await rm(destination, { force: true });
  };
}

async function readDescriptor(directory: string) {
  const flags = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(join(directory, descriptorFile), constants.O_RDONLY | flags);
  try {
    const info = await file.stat();
    const user = process.getuid?.();
    if (!info.isFile() || info.size > 1024 || (user !== undefined && (info.uid !== user || info.mode & 0o077))) {
      throw new Error('The Launcher automation endpoint is not private.');
    }
    const bytes = Buffer.alloc(1025);
    const { bytesRead } = await file.read(bytes);
    if (bytesRead > 1024) throw new Error('Invalid Launcher automation endpoint.');
    const { version, port, key } = record(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    if (
      version !== 1 ||
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      typeof key !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(key)
    ) {
      throw new Error('Invalid Launcher automation endpoint.');
    }
    return { port, key };
  } finally {
    await file.close();
  }
}

export async function sendAutomation(
  directory: string,
  request: AutomationRequest,
  signal?: AbortSignal,
): Promise<AutomationResult> {
  signal?.throwIfAborted();
  const { port, key } = await readDescriptor(directory).catch(() => {
    throw new Error('This library is busy and has no available Launcher automation endpoint.');
  });
  signal?.throwIfAborted();
  const socket = createConnection({ host: address, port });
  socket.on('error', () => {});
  const abort = () => socket.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const { nonce, proof } = record(await receive(socket, handshakeTimeout));
    if (
      typeof nonce !== 'string' ||
      !/^[0-9a-f]{48}$/u.test(nonce) ||
      !validSignature(signature(key, 'host', nonce), proof)
    ) {
      throw new Error('The running Launcher host could not be verified.');
    }
    const body = JSON.stringify(request);
    const outgoing = frame({ body, proof: signature(key, 'client', nonce, body) });
    const response = receive(socket);
    socket.write(outgoing);
    const reply = record(await response);
    if (reply.ok !== true) throw new Error(typeof reply.error === 'string' ? reply.error : unavailable);
    const result = record(reply.result);
    return { value: result.value, partial: result.partial === true };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    socket.destroy();
  }
}
