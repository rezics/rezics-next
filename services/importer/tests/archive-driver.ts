import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { Database, Statement } from 'bun:sqlite';
import type { IO } from '../../../specs/imports-archive-driver.ts';

type Boundary = keyof IO;
const active = new AsyncLocalStorage<IO[]>();
const wrapped = new WeakMap<object, Set<string>>();

function count(boundary: Boundary) {
  for (const io of active.getStore() ?? []) io[boundary]++;
}

/** Intercept real calls, forwarding arguments, receivers, results and failures.
 * Installation precedes the production import. Async context includes nested
 * calls/observations without attributing concurrent, unrelated work to a run.
 * Native addons and references captured before installation are not observable.
 */
function instrument(target: object, name: string, boundary: Boundary, result?: (value: unknown) => void) {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== 'function') return;
  let names = wrapped.get(target);
  if (!names) {
    names = new Set();
    wrapped.set(target, names);
  }
  if (names.has(name)) return;
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (descriptor && !descriptor.configurable && !descriptor.writable) {
    throw new Error(`Cannot observe ${name}`);
  }
  const replacement = new Proxy(original, {
    apply(fn, receiver, args) {
      count(boundary);
      const value: unknown = Reflect.apply(fn, receiver, args);
      result?.(value);
      return value;
    },
    construct(fn, args, constructor) {
      count(boundary);
      const value: object = Reflect.construct(fn, args, constructor);
      result?.(value);
      return value;
    },
  });
  Object.defineProperty(target, name, { configurable: true, writable: true, ...descriptor, value: replacement });
  names.add(name);
}
function methods(target: object, names: string[], boundary: Boundary) {
  for (const name of names) instrument(target, name, boundary);
}
function functions(target: object, boundary: Boundary, except: string[] = []) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (/^[a-z]/.test(name) && !except.includes(name)) instrument(target, name, boundary);
  }
}
function statement(value: unknown) {
  if (value && typeof value === 'object') methods(value, ['run', 'get', 'all', 'values', 'iterate', 'raw'], 'sqlite');
}

methods(Database.prototype, ['exec', 'run', 'loadExtension', 'serialize', 'deserialize'], 'sqlite');
for (const name of ['query', 'prepare']) instrument(Database.prototype, name, 'sqlite', statement);
methods(Statement.prototype, ['run', 'get', 'all', 'values', 'iterate'], 'sqlite');
// Bun's exported Database object is shared by the already imported loader.
const sqlite = require('bun:sqlite') as { Database: typeof Database };
instrument(sqlite, 'Database', 'sqlite');
// Observe the same pg runtime used for kernel partition storage, including
// queries issued through already connected clients and nested pool dispatch.
const kernelRequire = createRequire(new URL('../../kernel/package.json', import.meta.url));
const pg = kernelRequire('pg') as { Client: { prototype: object }; Pool: { prototype: object } };
methods(pg.Client.prototype, ['query'], 'partitions');
methods(pg.Pool.prototype, ['query'], 'partitions');
for (const name of ['sql', 'SQL']) {
  const sql: unknown = Reflect.get(Bun, name);
  if (typeof sql === 'function') methods(sql, ['unsafe', 'file', 'connect', 'begin', 'reserve'], 'partitions');
  instrument(Bun, name, 'partitions');
}
methods(globalThis, ['fetch', 'WebSocket', 'EventSource'], 'network');
for (const module of [http, https]) methods(module, ['request', 'get', 'createServer'], 'network');
methods(http2, ['connect', 'createServer', 'createSecureServer'], 'network');
methods(net, ['connect', 'createConnection', 'createServer'], 'network');
methods(net.Socket.prototype, ['connect'], 'network');
methods(tls, ['connect', 'createServer'], 'network');
methods(dgram, ['createSocket'], 'network');
methods(dgram.Socket.prototype, ['connect', 'send', 'sendto'], 'network');
functions(dns, 'network');
functions(dns.promises, 'network');
methods(Bun, ['connect', 'listen', 'udpSocket', 'serve'], 'network');
functions(childProcess, 'subprocess');
methods(Bun, ['spawn', 'spawnSync'], 'subprocess');
functions(fs, 'filesystem');
functions(fsPromises, 'filesystem', ['open']);
// A FileHandle's native methods do not re-enter the fs module.
instrument(fsPromises, 'open', 'filesystem', (value) => {
  void (value as Promise<object>).then(
    (handle) => {
      methods(
        handle,
        [
          'read',
          'readv',
          'readFile',
          'write',
          'writev',
          'writeFile',
          'appendFile',
          'stat',
          'truncate',
          'chmod',
          'chown',
          'utimes',
          'sync',
          'datasync',
          'close',
          'createReadStream',
          'createWriteStream',
        ],
        'filesystem',
      );
    },
    () => {},
  );
});
// Obtain the prototype before wrapping Bun.file; this creates no file on disk.
const filePrototype: object = Object.getPrototypeOf(Bun.file('.temp/archive-observer'));
methods(
  filePrototype,
  ['arrayBuffer', 'bytes', 'text', 'json', 'stream', 'slice', 'exists', 'stat', 'write', 'delete'],
  'filesystem',
);
instrument(filePrototype, 'writer', 'filesystem', (value) => {
  if (value && typeof value === 'object') methods(value, ['write', 'flush', 'end'], 'filesystem');
});
methods(Bun, ['file', 'write'], 'filesystem');
functions(console, 'logs');
methods(process.stdout, ['write'], 'logs');
methods(process.stderr, ['write'], 'logs');
syncBuiltinESMExports();

export async function observe<T>(operation: () => Promise<T>): Promise<{ value: T; io: IO }> {
  const io: IO = { sqlite: 0, partitions: 0, network: 0, filesystem: 0, subprocess: 0, logs: 0 };
  return active.run([...(active.getStore() ?? []), io], async () => ({ value: await operation(), io }));
}
