import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, installTestClock, repository } from './test-support.ts';

test('Git fixtures clone a per-file template with shared objects and isolated working trees', () => {
  const first = repository();
  const second = repository();
  try {
    const alternates = readFileSync(join(first.main, '.git/objects/info/alternates'), 'utf8').trim();
    expect(alternates).toContain('.git/objects');
    expect(readFileSync(join(second.main, '.git/objects/info/alternates'), 'utf8').trim()).toBe(alternates);
    expect(readFileSync(join(first.main, 'base'), 'utf8')).toBe('base\n');
    writeFileSync(join(first.main, 'only-first'), 'one\n');
    expect(existsSync(join(second.main, 'only-first'))).toBe(false);
    first.commit('only-first', 'one\n');
    expect(existsSync(join(second.main, 'only-first'))).toBe(false);
  } finally {
    first.close();
    second.close();
  }
});

test('harness clones share the fixture template without sharing later commits', () => {
  const first = harness();
  const second = harness();
  try {
    expect(readFileSync(join(first.root, '.git/objects/info/alternates'), 'utf8')).toContain('.git/objects');
    writeFileSync(join(first.root, 'only-first'), 'one\n');
    expect(existsSync(join(second.root, 'only-first'))).toBe(false);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test('an injected clock fires timers when time advances instead of sleeping', () => {
  const clock = installTestClock(1_000);
  try {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    expect(ticks).toBe(0);
    clock.advance(19);
    expect(ticks).toBe(0);
    clock.advance(1);
    expect(ticks).toBe(1);
    clock.advance(40);
    expect(ticks).toBe(3);
    clearInterval(timer);
    clock.advance(100);
    expect(ticks).toBe(3);
    expect(clock.now()).toBe(1_160);
  } finally {
    clock.restore();
  }
});
