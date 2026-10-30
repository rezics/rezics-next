import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bundledRelease } from '@rezics/definitions/bundled';
import entity from '../../../specs/fixtures/imports/wikidata/entity.json';
import { runImportCli } from '../src/cli.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const registration = createSourceRegistration('wikidata');
const input = (record: unknown) => ({ external_id: entity.id, record_revision: String(entity.lastrevid), record });
const context = { source: 'wikidata', subjectId: '00000000-0000-4000-8000-000000000001' };

test('ordinary Wikidata registration preserves rich cited statements across serialized staging', () => {
  const first = registration.convert(input(structuredClone(entity)), context);
  const staged = JSON.parse(JSON.stringify(first.normalized));
  const second = registration.convert(input(staged), context);
  expect(registration.converter_revision).toBe('wikidata-4');
  expect(second.proposals).toEqual(first.proposals);
  expect(second.digest).toBe(first.digest);
  expect(second.proposals).toHaveLength(6);
  const author = second.proposals.find((c) => c.op === 'propose' && c.statement.rank === 'preferred');
  expect(author?.op).toBe('propose');
  if (author?.op !== 'propose') throw new Error('Missing preferred author');
  expect(author.statement.value).toEqual({ type: 'somevalue' });
  expect(author.statement.qualifiers).toContainEqual({ property: { id: 'schema:position' }, value: { type: 'value', content: '1' } });
  expect(author.statement.references).toContainEqual({ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://catalogue.example.org/books/example' } }] });
  for (const proposal of second.proposals) {
    if (proposal.op === 'propose') expect(proposal.statement.references.length).toBeGreaterThan(0);
    expect(proposal.source.converter_revision).toBe('wikidata-4');
  }
});

test('registered exact measurements cannot lose qualification during serialize normalize reconvert', () => {
  expect(bundledRelease.properties['schema:wordCount']!.qualifiers).toEqual([]);
  const item = (property: string, id: string) => ({ snaktype: 'value', property, datatype: 'wikibase-item',
    datavalue: { type: 'wikibase-entityid', value: { id, 'entity-type': 'item', 'numeric-id': Number(id.slice(1)) } } });
  for (const qualifiers of [
    structuredClone(entity.claims.P50[0]!.qualifiers),
    { P459: [item('P459', 'Q718390')], P518: [item('P518', 'Q63246861')] },
    { P518: [{ snaktype: 'somevalue', property: 'P518', datatype: 'wikibase-item' }] },
  ]) {
    const record = { ...structuredClone(entity), claims: { ...structuredClone(entity.claims), P6570: [{
      type: 'statement', rank: 'normal', qualifiers,
      mainsnak: { snaktype: 'value', property: 'P6570', datatype: 'quantity',
        datavalue: { type: 'quantity', value: { amount: '+1450', unit: '1' } } },
    }] } };
    let output = registration.convert(input(record), context);
    for (let round = 0; round < 3; round++) {
      expect(output.proposals.filter((c) => c.op === 'propose' && c.statement.property.id === 'schema:wordCount')).toEqual([]);
      expect(output.diagnostics.some((d) => d.pointer === '/claims/P6570')).toBe(true);
      expect(output.proposals.filter((c) => c.op === 'propose')).toHaveLength(6);
      output = registration.convert(input(JSON.parse(JSON.stringify(output.normalized))), context);
    }
  }
});

test('rich JSONL CLI rejects a malformed tail before Auth or public effects', async () => {
  const directory = await mkdtemp('/dev/shm/wikidata-rich-cli-local-');
  try {
    const key = join(directory, 'account.jwk');
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeFile(key, JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }), { mode: 0o600 });
    const requests: string[] = [];
    const revisions: string[] = [];
    const result = await runImportCli([
      '--source', 'wikidata', '--dump', '-', '--state', join(directory, 'state.sqlite'),
      '--account-key', key, '--account', randomUUID(), '--client', 'rich-cli-local',
      '--api', 'https://api.import.test', '--auth', 'https://auth.import.test',
    ], {
      stdin: (async function* () { yield new TextEncoder().encode(`${JSON.stringify(entity)}\n{"id":`); })(),
      observer: { onCoordinator({ registration }) { revisions.push(registration.converter_revision); } },
      fetch: (async (request: Request) => { requests.push(request.url); throw new Error('Unexpected network effect before sealing'); }) as typeof fetch,
    });
    expect(revisions).toEqual(['wikidata-4']);
    expect(result.code).toBe(2);
    expect(result.openHandles).toBe(0);
    expect(requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Bearer ');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
