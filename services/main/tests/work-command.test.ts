import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CommandRejected, FusekiClient, type CommandEnvelope, type CommandResult,
  type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { activateMetadataWork, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { sealMetadataWorkAdmission } from '../src/modules/work/seal.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';

const root = resolve(import.meta.dir, '../../..');
const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

class InMemoryCommandFuseki extends FusekiClient {
  capturedCommand?: CommandEnvelope;
  result: CommandResult = { status: 'committed', position: {
    datasetId: 'urn:rezics:dataset:product', dataEpoch: 'epoch-a', sequence: '1',
  } };
  private receipt?: Record<string, { type: string; value: string }>;
  private invalidReceipt = false;
  commands = 0;

  constructor() { super('http://localhost:1/rezics'); }
  override async commandHealth() { return { moduleVersion: '0.1.0',
    profiles: { 'work-metadata-v1': profileRegistry['work-metadata-v1'].sha256 } }; }
  override async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('ASK') && sparql.includes('rv:InvalidProfile')) {
      return { boolean: this.invalidReceipt };
    }
    if (sparql.includes('SELECT ?digest ?outcome ?kind')) {
      return { results: { bindings: this.invalidReceipt ? [{ digest: literal(this.capturedCommand!.digest),
        outcome: uri('https://rezics.com/vocab/Cancelled'),
        kind: uri('https://rezics.com/vocab/InvalidProfile') }] : [] } };
    }
    if (!sparql.includes('SELECT ?outcome ?digest')) throw new Error('unexpected query');
    return { results: { bindings: this.receipt ? [this.receipt] : [] } };
  }
  override async commandWithReceipt(command: CommandEnvelope): Promise<CommandResult> {
    this.commands += 1;
    this.capturedCommand = command;
    if (this.invalidReceipt && command.validations.length > 0) {
      return { status: 'committed', position: {
        datasetId: 'urn:rezics:dataset:product', dataEpoch: 'epoch-a', sequence: '1',
      } };
    }
    if (this.result.status === 'invalid' && command.validations.length === 0) {
      this.invalidReceipt = true;
      this.receipt = { outcome: uri('https://rezics.com/vocab/Cancelled'),
        digest: literal(command.digest), admissionId: literal('00000000-0000-4000-8000-000000000001'),
        authorityEpoch: literal('1'), scope: literal('work:create:root'),
        sequence: literal('1'), epoch: literal('epoch-a') };
      return { status: 'committed', position: {
        datasetId: 'urn:rezics:dataset:product', dataEpoch: 'epoch-a', sequence: '1',
      } };
    }
    if (this.result.status === 'committed') {
      const work = command.update.match(/rv:work <(https:\/\/rezics\.com\/id\/[^>]+)> ; rv:mainVersion/)?.[1];
      const main = command.update.match(/rv:mainVersion <(https:\/\/rezics\.com\/id\/[^>]+)> ; rv:workRevision/)?.[1];
      const workRevision = command.update.match(/rv:workRevision <(https:\/\/rezics\.com\/id\/[^>]+)> ; rv:mainRevision/)?.[1];
      const mainRevision = command.update.match(/rv:mainRevision <(https:\/\/rezics\.com\/id\/[^>]+)> ; rv:datasetId/)?.[1];
      if (!work || !main || !workRevision || !mainRevision) throw new Error('incomplete Work receipt update');
      this.receipt = { outcome: uri('https://rezics.com/vocab/Succeeded'),
        digest: literal(command.digest), admissionId: literal('00000000-0000-4000-8000-000000000001'),
        authorityEpoch: literal('1'), scope: literal('work:create:root'),
        work: uri(work), main: uri(main), workRevision: uri(workRevision),
        mainRevision: uri(mainRevision), sequence: literal('1'), epoch: literal('epoch-a') };
    }
    return this.result;
  }
}

test('SYS02/SYS10 Work creation sends guarded update and both generated SHACL focuses', async () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const state = mkdtempSync(join(root, '.temp', 'work-command-'));
  try {
    const fuseki = new InMemoryCommandFuseki();
    const env: WorkActivationEnvironment = { fuseki,
      lineage: { dataEpoch: 'epoch-a', routingEpoch: '1' }, objectDirectory: join(state, 'objects') };
    const title = 'Command Work';
    const result = await activateMetadataWork(env, { title,
      admission: { id: '00000000-0000-4000-8000-000000000001', scope: 'work:create:root',
        action: 'work.create', idempotencyKey: 'command-work', authorityEpoch: '1',
        requestDigest: metadataWorkRequestDigest(title), expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    expect(result.sequence).toBe('1');
    expect(fuseki.capturedCommand?.receipt).toBe(result.receipt);
    expect(fuseki.capturedCommand?.digest).toBe(metadataWorkRequestDigest(title));
    expect(fuseki.capturedCommand?.update).toContain(`FILTER NOT EXISTS { GRAPH <urn:rezics:graph:receipts> { <${result.receipt}> ?p ?o } }`);
    expect(fuseki.capturedCommand?.validations.map(entry => entry.shape)).toEqual([...profileRegistry['work-metadata-v1'].shapes]);
    expect(fuseki.capturedCommand?.validations.map(entry => entry.focus[0])).toEqual([result.work, result.mainVersion]);
    expect(fuseki.capturedCommand?.validations.every(entry => entry.graphs.join() === 'urn:rezics:graph:current')).toBe(true);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('SYS02 invalid native Work validation leaves a terminal cancellation for seal and rejects replay', async () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const state = mkdtempSync(join(root, '.temp', 'work-command-'));
  try {
    const fuseki = new InMemoryCommandFuseki();
    fuseki.result = { status: 'invalid', report: 'shape rejected' };
    const env: WorkActivationEnvironment = { fuseki,
      lineage: { dataEpoch: 'epoch-a', routingEpoch: '1' }, objectDirectory: join(state, 'objects') };
    const intent = { title: 'Rejected Work',
      admission: { id: '00000000-0000-4000-8000-000000000001', scope: 'work:create:root',
        action: 'work.create', idempotencyKey: 'rejected-work', authorityEpoch: '1',
        requestDigest: metadataWorkRequestDigest('Rejected Work'),
        expiresAt: new Date(Date.now() + 60_000).toISOString() } };
    await expect(activateMetadataWork(env, intent)).rejects.toBeInstanceOf(CommandRejected);
    const commands = fuseki.commands;
    const terminal = await sealMetadataWorkAdmission(env, { ...intent.admission, principalId: 'principal',
      actingSubject: 'principal', state: 'claimed', dispatchEligible: true, replayed: false } satisfies RegisteredAdmission);
    expect(terminal.outcome).toBe('cancelled');
    expect(terminal.admissionId).toBe(intent.admission.id);
    expect(terminal.requestDigest).toBe(intent.admission.requestDigest);
    expect(terminal.scope).toBe(intent.admission.scope);
    expect(fuseki.commands).toBe(commands);
    await expect(activateMetadataWork(env, intent)).rejects.toBeInstanceOf(CommandRejected);
    expect(fuseki.commands).toBe(commands);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
