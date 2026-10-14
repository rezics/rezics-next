import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createIndependentRestoreChildEnvironment, independentRestoreSourceAdapter, resolveIndependentRestoreInputs,
  type IndependentRestoreTransfer } from '../fault-recovery/independent-restore-support.ts';
import { artifactNames } from '../../../scripts/ops/recovery-set.ts';
import { RetainedSources, type RetainedSourceAdapter } from '../../../scripts/qa/retained-source.ts';
import { sha256 } from '../../../scripts/fixture/corpus.ts';
import type { RetainedOwnerState } from '../../../scripts/fixture/manifest.ts';

const root = resolve(import.meta.dir, '../../..');

test('independent consumers refuse absent custody without invoking production', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'independent-missing-'));
  try {
    const adapter = independentRestoreSourceAdapter(false, { native: 'unit' });
    let builds = 0;
    adapter.build = async () => { builds++; throw new Error('must not build'); };
    const sources = new RetainedSources(directory);
    await expect(sources.select(adapter)).rejects.toThrow('complete manifest is missing');
    await expect(sources.restore(adapter)).rejects.toThrow('complete manifest is missing');
    expect(builds).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the physical adapter copies the complete transfer, assigns private targets and leaves retained bytes immutable', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'independent-copy-'));
  const physical = independentRestoreSourceAdapter(false, { native: 'unit' });
  // Only production and Docker verification are replaced; copying is the real
  // physical adapter, under the real manifest/lease/immutability lifecycle.
  const adapter: RetainedSourceAdapter<RetainedOwnerState, Awaited<ReturnType<typeof physical.restore>>> = {
    ...physical,
    build: async context => {
      mkdirSync(join(context.backup, 'set'), { recursive: true });
      mkdirSync(join(context.backup, 'keys'));
      for (const name of [...artifactNames, 'set.json']) writeFileSync(join(context.backup, 'set', name), `immutable ${name}`);
      for (const name of ['frontier', 'authority', 'native.gpg', 'relay.dump', 'hmac', 'signing', 'keys/private'])
        writeFileSync(join(context.backup, name), `retained ${name}`);
      const samples = { project: 'rezics-qa-old', source: { project: 'destroyed-source' },
        revisionId: 'revision', original: { receipt: 'original', dataEpoch: 'epoch', sequence: '42' } };
      writeFileSync(join(context.backup, 'expectations.json'), JSON.stringify({
        format: 'rezics-independent-restore-expectations-v1', samples: [{ name: 'erasedRevision', id: 'revision' }],
        values: [{ name: 'sample0', value: JSON.stringify(samples) }], originalReceiptTuples: [['original', 'epoch', '42']],
      }));
      const transfer: IndependentRestoreTransfer = { format: 'rezics-independent-restore-inputs-v1',
        root: relative(root, context.backup), expectations: 'expectations.json', inputs: {
          recoverySet: 'set', currentFrontier: 'frontier', currentAuthorityCoverage: 'authority',
          nativeAccessAttachment: 'native.gpg', currentRelayDump: 'relay.dump', recipientPrivateKeyCustody: 'keys',
          recoveryHmacKey: 'hmac', retainedNativeSigningMaterial: 'signing',
        } };
      return { metadata: JSON.parse(JSON.stringify({ transfer })) as RetainedOwnerState,
        rdfDigest: sha256('unit RDF'), ownerState: { cut: '42' }, producerRevision: 'unit', qaIdentity: 'unit', phases: {} };
    },
    verify: async () => [],
    dispose: async candidate => { rmSync(candidate.directory, { recursive: true, force: true }); },
  };
  const sources = new RetainedSources(directory);
  const copies: { candidate: Awaited<ReturnType<typeof physical.restore>>; dispose(): Promise<void> }[] = [];
  try {
    const prepared = await sources.prepare(adapter);
    const before = await sources.select(adapter);
    const first = await sources.restore(adapter);
    copies.push(first);
    const second = await sources.restore(adapter);
    copies.push(second);
    expect(first.candidate.directory).not.toBe(second.candidate.directory);
    const inputs = copies.map(copy => resolveIndependentRestoreInputs(copy.candidate.transfer));
    const child = createIndependentRestoreChildEnvironment({ PATH: '/usr/bin:/bin', GOAL_IN_SLOT: '1',
      GOAL_QA_SLOT_DIRECTORY: '/qa/slots', REZICS_QA_STARTUP_SLOT_GATE: '/qa/startup',
      REZICS_QA_MEMORY_DEADLINE: '42', REZICS_QA_MEMORY_EVENTS: '1', REZICS_QA_STACK_REGISTRY: '/qa/registry',
      DATABASE_URL: 'postgresql://former-source', NODE_OPTIONS: '--require=/former-source' }, inputs[0]!);
    expect(child.PATH).toBe('/usr/bin:/bin');
    expect(child.GOAL_IN_SLOT).toBe('1');
    expect(child.GOAL_QA_SLOT_DIRECTORY).toBe('/qa/slots');
    expect(child.REZICS_QA_STARTUP_SLOT_GATE).toBe('/qa/startup');
    expect(child.REZICS_QA_MEMORY_DEADLINE).toBe('42');
    expect(child.REZICS_QA_MEMORY_EVENTS).toBe('1');
    expect(child.REZICS_QA_STACK_REGISTRY).toBe('/qa/registry');
    expect(child.DATABASE_URL).toBeUndefined();
    expect(child.NODE_OPTIONS).toBeUndefined();
    const samples = inputs.map(input => JSON.parse(readFileSync(input.expectations, 'utf8')));
    const facts = samples.map(sample => JSON.parse(sample.values.map((value: { value: string }) => value.value).join('')));
    expect(facts[0].project).not.toBe(facts[1].project);
    expect(facts[0].original).toEqual(facts[1].original);
    expect(samples[0].originalReceiptTuples).toEqual([['original', 'epoch', '42']]);
    writeFileSync(join(inputs[0]!.recoverySet, 'set.json'), 'private mutation');
    expect(readFileSync(join(inputs[1]!.recoverySet, 'set.json'), 'utf8')).toBe('immutable set.json');
    await first.dispose();
    expect(readFileSync(inputs[1]!.currentAuthorityCoverage, 'utf8')).toBe('retained authority');
    expect((await sources.select(adapter)).digest).toBe(before.digest);
    expect(before.digest).toBe(prepared.manifest.digest);
    const incompatible = { ...adapter, specification: { ...adapter.specification, compatibility: { native: 'different' } } };
    await expect(sources.restore(incompatible)).rejects.toThrow('complete manifest is missing');
  } finally {
    for (const copy of copies) await copy.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
