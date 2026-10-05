import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, type MediaStack } from './media-support.ts';
import type { subjectStatementPage } from '../../../services/main/src/modules/entity-page/contract.ts';
import type { Static } from 'typebox';

const RV = 'https://rezics.com/vocab/';
const short = (ref: string) => ref.slice(-36);
let stack: MediaStack;

beforeAll(async () => { stack = await startMediaStack('entity-page-structure'); }, 240_000);
afterAll(async () => { await stack?.stop(); });

test('a place page lists its own facts but not the owner pointer, which the Relations section already shows', async () => {
  const owner = await stack.member('structure-owner');
  const work = (await stack.publicWork(owner.actor)).work;
  await owner.grant('semantic:create:root', 'semantic.change');
  await owner.grant(`work:read:${work}`, 'work.read');
  const response = await owner.send('POST', '/v1/semantic/changes', {
    profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
    state: { component: 'resource', types: [`${RV}Character`], properties: [
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: `Subject ${randomUUID()}`, language: 'en' } },
      { predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: work } },
    ] },
  });
  expect(response.status).toBe(201);
  const { component } = await response.json() as { component: string };
  await owner.grant(`semantic:read:${component}`, 'semantic.read');
  const read = await owner.read(`/v1/resources/${short(component)}/statements`);
  expect(read.status).toBe(200);
  const page = await read.json() as Static<typeof subjectStatementPage>;
  const predicates = page.groups.map(group => group.predicate);
  expect(predicates).toContain('https://schema.org/name');
  expect(predicates).not.toContain(`${RV}semanticWork`);
}, 120_000);
