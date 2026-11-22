import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Pool } from 'pg';
import { enterCommandGate } from '../../src/command/gate.ts';

test('serialization retries wait across homes while other homes can make first attempts', async () => {
  const pool = new Pool();
  const group = Symbol('create');
  const until = Date.now() + 5000;
  const firstRetry = await enterCommandGate(pool, 1, until, group);
  assert(firstRetry.status === 'acquired');

  let entered = false;
  const secondRetry = enterCommandGate(pool, 2, until, group).then((gate) => {
    entered = true;
    return gate;
  });
  const unrelated = await enterCommandGate(pool, 3, until);
  assert(unrelated.status === 'acquired');
  unrelated.release();
  assert.equal(entered, false);

  firstRetry.release();
  const next = await secondRetry;
  assert(next.status === 'acquired');
  next.release();
  await pool.end();
});

test('a retry reaching its group deadline releases its home for the next attempt', async () => {
  const pool = new Pool();
  const group = Symbol('create');
  const first = await enterCommandGate(pool, 1, Date.now() + 5000, group);
  assert(first.status === 'acquired');
  const expired = await enterCommandGate(pool, 2, Date.now() + 20, group);
  assert.equal(expired.status, 'deadline');
  const home = await enterCommandGate(pool, 2, Date.now() + 5000);
  assert(home.status === 'acquired');
  home.release();
  first.release();
  await pool.end();
});
