import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, mock, test } from 'bun:test';

const realFs = await import('node:fs');
const realFsModule = { ...realFs };
const realLstatSync = realFs.lstatSync;
const realReaddirSync = realFs.readdirSync;
const realRealpathSync = realFs.realpathSync;
let afterLstat: ((path: unknown) => void) | undefined;
let afterReaddir: ((path: unknown) => void) | undefined;
mock.module('node:fs', () => ({
  ...realFsModule,
  lstatSync: (...args: Parameters<typeof realFs.lstatSync>) => {
    const stat = realLstatSync(...args);
    afterLstat?.(args[0]);
    return stat;
  },
  readdirSync: (...args: Parameters<typeof realFs.readdirSync>) => {
    const entries = realReaddirSync(...args);
    afterReaddir?.(args[0]);
    return entries;
  },
}));

const { removeOwnedTree } = await import('./task-workspace.ts');
const { captureTrainWorktreeRemoval } = await import('./train-workspace.ts');

afterAll(() => mock.restore());

function temporaryTree(): string {
  const root = resolve(import.meta.dir, '../../../.temp/goal-tests');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'disappearing-cleanup-'));
}

function removeTemporaryTree(path: string, writableChildren: string[]): void {
  if (!existsSync(path)) return;
  for (const child of writableChildren) {
    if (existsSync(child)) chmodSync(child, 0o700);
  }
  chmodSync(path, 0o700);
  rmSync(path, { recursive: true, force: true });
}

test('owned task cleanup skips a directory that disappears after stat and removes the remaining tree', () => {
  const tree = temporaryTree();
  const disappearing = join(tree, 'disappearing');
  const remaining = join(tree, 'remaining');
  mkdirSync(disappearing);
  mkdirSync(remaining);
  writeFileSync(join(tree, 'root-file'), 'root bytes');
  writeFileSync(join(remaining, 'nested-file'), 'nested bytes');
  chmodSync(remaining, 0o555);
  chmodSync(tree, 0o555);

  let removed = false;
  afterLstat = (path) => {
    if (!removed && typeof path === 'string' && path.endsWith('/disappearing')) {
      removed = true;
      rmdirSync(disappearing);
    }
  };
  try {
    expect(removeOwnedTree(tree)).toBe(Buffer.byteLength('root bytes') + Buffer.byteLength('nested bytes'));
    expect(removed).toBe(true);
    expect(existsSync(tree)).toBe(false);
  } finally {
    afterLstat = undefined;
    removeTemporaryTree(tree, [remaining]);
  }
});

test('owned train cleanup skips a directory removed at its final identity check and prepares remaining entries', () => {
  const tree = temporaryTree();
  const disappearing = join(tree, 'disappearing');
  const remaining = join(tree, 'remaining');
  mkdirSync(disappearing);
  mkdirSync(remaining);
  const sentinel = join(remaining, 'sentinel');
  writeFileSync(sentinel, 'keep');
  chmodSync(sentinel, 0o444);
  chmodSync(disappearing, 0o555);
  chmodSync(remaining, 0o555);
  chmodSync(tree, 0o555);

  const prepareRemoval = captureTrainWorktreeRemoval(tree);
  let removed = false;
  afterReaddir = (path) => {
    if (
      !removed &&
      typeof path === 'string' &&
      path.startsWith('/proc/self/fd/') &&
      realRealpathSync(path) === disappearing
    ) {
      removed = true;
      rmdirSync(disappearing);
    }
  };
  try {
    prepareRemoval();
    expect(removed).toBe(true);
    expect(existsSync(disappearing)).toBe(false);
    expect(realLstatSync(remaining).mode & 0o700).toBe(0o700);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
    expect(realLstatSync(sentinel).mode & 0o777).toBe(0o444);
  } finally {
    afterReaddir = undefined;
    removeTemporaryTree(tree, [remaining]);
  }
});
