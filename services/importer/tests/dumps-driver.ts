import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Database } from 'bun:sqlite';
import type { ImportDumpsDriver } from '../../../specs/imports-dumps-driver';

type Effects = Awaited<ReturnType<ImportDumpsDriver['effects']>>;
type Boundary = keyof Effects;
const bindings = new Map<Effects, () => boolean>();
const restores: (() => void)[] = [];

/** Runtime interception covers JS builtin entry points, not native addons or
 * function references captured before installation. FileHandle writes through
 * previously opened handles and third-party native DB clients are outside interception.
 * The production module imports only types and its local byte helper; its full
 * runtime dependency graph therefore uses none of those unobservable paths.
 */
export const instrumentationLimits = [
  'Native addons, pre-captured functions and previously opened FileHandles',
  'Previously prepared SQLite statements with native per-instance methods',
  'Third-party database clients with their own native transports',
];

function attempt(boundary: Boundary, name: string, args: unknown[]): void {
  const detail = `${name}: ${String(args[0] ?? '')}`;
  let blocked = false;
  for (const [effects, active] of bindings) {
    // Transport stays intercepted between measurements, including staging.
    if (boundary === 'requests' || active()) {
      effects[boundary].push(detail);
      blocked = true;
    }
  }
  if (blocked) throw new Error(`Dump reader attempted ${boundary} boundary`);
}

function replace(target: object, name: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || (!descriptor.configurable && !descriptor.writable)) {
    throw new Error(`Cannot instrument ${name}`);
  }
  Object.defineProperty(target, name, { ...descriptor, value });
  restores.push(() => Object.defineProperty(target, name, descriptor));
}

function block(target: object, names: string[], boundary: Boundary, prefix: string) {
  for (const name of names) {
    if (typeof Reflect.get(target, name) !== 'function') continue;
    const original = Reflect.get(target, name) as Function;
    replace(target, name, function (this: unknown, ...args: unknown[]) {
      attempt(boundary, `${prefix}.${name}`, args);
      return new.target ? Reflect.construct(original, args, new.target) : Reflect.apply(original, this, args);
    });
  }
}

function install() {
  try {
    block(globalThis, ['fetch', 'WebSocket', 'EventSource'], 'requests', 'global');
    block(http, ['request', 'get'], 'requests', 'http');
    block(https, ['request', 'get'], 'requests', 'https');
    block(net, ['connect', 'createConnection'], 'requests', 'net');
    block(net.Socket.prototype, ['connect'], 'requests', 'Socket');
    block(tls, ['connect'], 'requests', 'tls');
    block(dgram.Socket.prototype, ['connect', 'send', 'sendto'], 'requests', 'dgram');
    block(Bun, ['connect', 'listen', 'udpSocket'], 'requests', 'Bun');
    block(
      childProcess,
      ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'],
      'fileWrites',
      'child_process',
    );
    block(Bun, ['spawn', 'spawnSync', 'write'], 'fileWrites', 'Bun');
    const mutations = [
      'write',
      'writeSync',
      'writev',
      'writevSync',
      'writeFile',
      'writeFileSync',
      'appendFile',
      'appendFileSync',
      'createWriteStream',
      'truncate',
      'truncateSync',
      'ftruncate',
      'ftruncateSync',
      'rename',
      'renameSync',
      'unlink',
      'unlinkSync',
      'rm',
      'rmSync',
      'rmdir',
      'rmdirSync',
      'mkdir',
      'mkdirSync',
      'copyFile',
      'copyFileSync',
      'cp',
      'cpSync',
      'link',
      'linkSync',
      'symlink',
      'symlinkSync',
      'chmod',
      'chmodSync',
      'chown',
      'chownSync',
      'utimes',
      'utimesSync',
      'mkdtemp',
      'mkdtempSync',
    ];
    block(fs, mutations, 'fileWrites', 'fs');
    block(fsPromises, mutations, 'fileWrites', 'fs.promises');
    for (const target of [fs, fsPromises]) {
      for (const name of ['open', 'openSync']) {
        const original = Reflect.get(target, name);
        if (typeof original !== 'function') continue;
        replace(target, name, function (this: unknown, ...args: unknown[]) {
          const flags = args[1];
          const writable =
            typeof flags === 'number'
              ? (flags &
                  (fs.constants.O_WRONLY |
                    fs.constants.O_RDWR |
                    fs.constants.O_CREAT |
                    fs.constants.O_TRUNC |
                    fs.constants.O_APPEND)) !==
                0
              : typeof flags === 'string' && /[wa+]/.test(flags);
          if (writable) attempt('fileWrites', `fs.${name}`, args);
          const result = Reflect.apply(original, this, args);
          if (target !== fsPromises) return result;
          return (result as Promise<object>).then((handle: object) => {
            // Native FileHandle methods bypass fs.writeFile; instrument each
            // returned handle as well as the module-level entry points.
            for (const method of [
              'write',
              'writev',
              'writeFile',
              'appendFile',
              'truncate',
              'chmod',
              'chown',
              'utimes',
              'createWriteStream',
            ]) {
              if (typeof Reflect.get(handle, method) !== 'function') continue;
              const own = Object.getOwnPropertyDescriptor(handle, method);
              const originalMethod = Reflect.get(handle, method) as Function;
              Object.defineProperty(handle, method, {
                configurable: true,
                writable: true,
                value: (...values: unknown[]) => {
                  attempt('fileWrites', `FileHandle.${method}`, values);
                  return Reflect.apply(originalMethod, handle, values);
                },
              });
              restores.push(() => {
                if (own) Object.defineProperty(handle, method, own);
                else Reflect.deleteProperty(handle, method);
              });
            }
            return handle;
          });
        });
      }
    }
    block(
      Object.getPrototypeOf(Bun.file('.temp/instrumentation-placeholder')),
      ['write', 'writer', 'delete', 'unlink'],
      'fileWrites',
      'BunFile',
    );
    block(Database.prototype, ['run', 'exec', 'query', 'prepare', 'loadExtension'], 'sql', 'sqlite');
    const sqlite = require('bun:sqlite') as { Database: typeof Database; Statement: { prototype: object } };
    block(sqlite.Statement.prototype, ['run', 'all', 'get', 'iterate', 'values'], 'sql', 'sqlite.Statement');
    replace(
      sqlite,
      'Database',
      new Proxy(sqlite.Database, {
        construct: (target, args, newTarget) => {
          attempt('sql', 'sqlite.Database', args);
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    // Bun's SQL callable uses the same runtime object via Bun.sql and imports
    // from bun. Intercept both construction and calls before product loading.
    for (const name of ['sql', 'SQL']) {
      const original = Reflect.get(Bun, name);
      if (typeof original !== 'function') continue;
      block(original, ['unsafe', 'file', 'connect', 'begin', 'transaction', 'reserve'], 'sql', `Bun.${name}`);
      replace(
        Bun,
        name,
        new Proxy(original, {
          apply: (target, receiver, args) => {
            attempt('sql', `Bun.${name}`, args);
            return Reflect.apply(target, receiver, args);
          },
          construct: (target, args, newTarget) => {
            attempt('sql', `Bun.${name}`, args);
            return Reflect.construct(target, args, newTarget);
          },
        }),
      );
    }
    syncBuiltinESMExports();
  } catch (error) {
    restore();
    throw error;
  }
}

function restore() {
  for (const undo of restores.splice(0).reverse()) undo();
  syncBuiltinESMExports();
}

export async function createImportDumpsDriver(active: () => boolean = () => true): Promise<ImportDumpsDriver> {
  const effects: Effects = { sql: [], requests: [], fileWrites: [] };
  bindings.set(effects, active);
  try {
    if (bindings.size === 1) install();
    const { readDump } = await import('../src/dumps');
    let closed = false;
    return {
      read: readDump,
      effects: async () => ({
        sql: [...effects.sql],
        requests: [...effects.requests],
        fileWrites: [...effects.fileWrites],
      }),
      close: async () => {
        if (closed) return;
        closed = true;
        bindings.delete(effects);
        if (!bindings.size) restore();
      },
    };
  } catch (error) {
    bindings.delete(effects);
    if (!bindings.size) restore();
    throw error;
  }
}
