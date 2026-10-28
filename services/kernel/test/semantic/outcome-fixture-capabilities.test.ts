import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';

let driver: SemanticOutcomeDriver;
const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
beforeAll(async () => { driver = await createSemanticDriver(); }, 180_000);
afterAll(async () => { await driver?.close(); }, 180_000);

test('native outcome people can request explicitly restricted known scopes without changing defaults', async () => {
  const restricted = await driver.fixtures.person('scope-restricted', { scopes: ['subject:read'] });
  await driver.fixtures.grantAccount(restricted, ['subject:create']);
  const denied = await driver.fixtures.send(restricted, 'POST', '/v1/subjects',
    { type: 'schema:Person', labels: { en: 'Denied by token scope' } }, key());
  expect(denied.status).toBe(403);
  const ordinary = await driver.fixtures.person('scope-default');
  await driver.fixtures.grantAccount(ordinary, ['subject:create']);
  const allowed = await driver.fixtures.send(ordinary, 'POST', '/v1/subjects',
    { type: 'schema:Person', labels: { en: 'Default scope remains available' } }, key());
  expect(allowed.status).toBe(201);
  const publicRead = await driver.fixtures.send(restricted, 'GET', '/v1/definitions/active');
  expect(publicRead.status).toBe(200);
}, 120_000);

test('one fixture person name cannot be rebound to incompatible scope sets', async () => {
  const first = await driver.fixtures.person('scope-stable', { scopes: ['subject:read', 'definitions:read'] });
  const same = await driver.fixtures.person('scope-stable', { scopes: ['definitions:read', 'subject:read'] });
  expect(same.accountId).toBe(first.accountId);
  await expect(driver.fixtures.person('scope-stable', { scopes: ['subject:read'] })).rejects.toThrow();
  await expect(driver.fixtures.person('scope-stable')).rejects.toThrow();
  await expect(driver.fixtures.person('scope-unknown', { scopes: ['fixture:unknown'] })).rejects.toThrow();
  await expect(driver.fixtures.person('scope-service-only', { scopes: ['media:complete'] })).rejects.toThrow();
  const empty = await driver.fixtures.person('scope-empty', { scopes: [] });
  await driver.fixtures.grantAccount(empty, ['context:create']);
  const denied = await driver.fixtures.send(empty, 'POST', '/v1/contexts', { labels: { en: 'Denied' } }, key());
  expect(denied.status).toBe(403);
}, 120_000);

test('fixture send transports DELETE through real Auth Access and native resource routes', async () => {
  const owner = await driver.fixtures.person('delete-owner');
  const created = await driver.fixtures.send(owner, 'POST', '/v1/collections',
    { title: 'Native DELETE transport', visibility: 'private' }, key());
  expect(created.status).toBe(201);
  const collection = created.body.collection as { id: string; revision: number };
  const removed = await driver.fixtures.send(owner, 'DELETE',
    `/v1/collections/${collection.id}?revision=${collection.revision}`, undefined, key());
  expect(removed.status).toBe(204);
  expect(removed.headers).toBeInstanceOf(Headers);
  expect((await driver.fixtures.send(owner, 'GET', `/v1/collections/${collection.id}`)).status).toBe(404);
}, 120_000);
