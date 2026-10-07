import { test, expect } from 'bun:test';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FusekiClient, type CommandEnvelope, type CommandResult } from '../src/infrastructure/fuseki.ts';
import { activateMetadataWork, IdempotencyConflict, initializeFreshGraph,
  metadataWorkRequestDigest, PendingActivation, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { editMetadataWork, metadataWorkEditDigest, StaleWorkHead } from '../src/modules/work/edit.ts';
import { readExactWorkRevision, RevisionCorrupt, RevisionNotFound, RevisionUnavailable } from '../src/modules/work/history.ts';

const root = resolve(import.meta.dir, '../../..');

test('SYS02/SYS09/SYS10/SYS14 partial: guarded Work edit and exact retained history', async () => {
  const fusekiUrl = Bun.env.FUSEKI_URL;
  const dataEpoch = Bun.env.MAIN_DATA_EPOCH;
  const routingEpoch = Bun.env.MAIN_ROUTING_EPOCH;
  if (!Bun.env.REZICS_QA_RUN_ID || !fusekiUrl || !dataEpoch || !routingEpoch) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `work-edit-${Bun.randomUUIDv7()}`);
  const fuseki = new FusekiClient(fusekiUrl);
  const lineage = { dataEpoch, routingEpoch };
  const env: WorkActivationEnvironment = { fuseki, lineage, objectDirectory: join(state, 'objects'),
    candidateDirectory: join(state, 'candidates') };
  try {
    await initializeFreshGraph(fuseki, lineage);
    const createAdmission = { id: Bun.randomUUIDv7(), scope: 'work:create:root', action: 'work.create',
      idempotencyKey: 'edit-base', requestDigest: metadataWorkRequestDigest('Original title'),
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const created = await activateMetadataWork(env, { admission: createAdmission, title: 'Original title' });
    const firstHead = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head WHERE {
      GRAPH <urn:rezics:graph:current> { <${created.work}> rv:head ?head }
    }`)).results?.bindings[0]?.head?.value!;
    expect(firstHead).toMatch(/^https:\/\/rezics\.com\/id\//);
    const first = await readExactWorkRevision(env, firstHead, async () => true);
    expect(first.title).toBe('Original title');
    expect(first.mainVersion).toBe(created.mainVersion);
    expect(first.sourcePosition.sequence).toBe('1');
    await expect(readExactWorkRevision(env, firstHead, async () => false))
      .rejects.toBeInstanceOf(RevisionNotFound);
    await expect(readExactWorkRevision(env, `https://rezics.com/id/${Bun.randomUUIDv7()}`, async () => true))
      .rejects.toBeInstanceOf(RevisionNotFound);
    const editAdmission = (key: string, head: string, title: string) => ({
      id: Bun.randomUUIDv7(), scope: `work:edit:${created.work}`, action: 'work.edit',
      requestDigest: metadataWorkEditDigest(created.work, head, title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), key,
    });
    const firstEdit = { admission: editAdmission('first', firstHead, 'Updated title'),
      work: created.work, expectedHead: firstHead, title: 'Updated title' };
    const edited = await editMetadataWork(env, firstEdit);
    expect(edited.sequence).toBe('2');
    expect(edited.predecessor).toBe(firstHead);
    expect(edited.replayed).toBe(false);
    expect(await editMetadataWork(env, firstEdit)).toEqual({ ...edited, replayed: true });
    await expect(editMetadataWork(env, { ...firstEdit, title: 'Different intent' }))
      .rejects.toBeInstanceOf(IdempotencyConflict);
    const newRevision = await readExactWorkRevision(env, edited.revision, async work => work === created.work);
    expect(newRevision.title).toBe('Updated title');
    expect(newRevision.predecessor).toBe(firstHead);
    expect((await readExactWorkRevision(env, firstHead, async () => true)).title).toBe('Original title');
    const after = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head ?title WHERE {
      GRAPH <urn:rezics:graph:current> { <${created.work}> rv:head ?head ;
        <http://www.w3.org/2000/01/rdf-schema#label> ?title }
    }`)).results?.bindings[0];
    expect(after?.head?.value).toBe(edited.revision);
    expect(after?.title?.value).toBe('Updated title');
    const competing = ['Competing A', 'Competing B'].map((title, index) => ({
      admission: editAdmission(`race-${index}`, edited.revision, title),
      work: created.work, expectedHead: edited.revision, title,
    }));
    const races = await Promise.allSettled(competing.map(intent => editMetadataWork(env, intent)));
    const winner = races.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof editMetadataWork>>> =>
      outcome.status === 'fulfilled');
    const loser = races.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(winner).toHaveLength(1);
    expect(loser).toHaveLength(1);
    expect(loser[0]!.reason).toBeInstanceOf(StaleWorkHead);
    expect(winner[0]!.value.sequence).toBe('3');
    expect((await readExactWorkRevision(env, firstHead, async () => true)).title).toBe('Original title');
    expect((await readExactWorkRevision(env, winner[0]!.value.revision, async () => true)).title)
      .toBe(competing[races[0]!.status === 'fulfilled' ? 0 : 1]!.title);
    class LostResponseClient extends FusekiClient {
      override async command(envelope: CommandEnvelope): Promise<CommandResult> {
        await super.command(envelope);
        throw new Error('simulated lost edit response');
      }
    }
    const latest = winner[0]!.value.revision;
    const lostIntent = { admission: editAdmission('lost', latest, 'After lost response'),
      work: created.work, expectedHead: latest, title: 'After lost response' };
    const recovered = await editMetadataWork({ ...env,
      fuseki: new LostResponseClient(fusekiUrl) }, lostIntent);
    expect(recovered.sequence).toBe('5');
    expect(recovered.replayed).toBe(false);
    expect((await readExactWorkRevision(env, latest, async () => true)).title)
      .toBe(competing[races[0]!.status === 'fulfilled' ? 0 : 1]!.title);
    const invalid = { admission: editAdmission('invalid', recovered.revision, 'placeholder'),
      work: created.work, expectedHead: recovered.revision, title: '' };
    await expect(editMetadataWork(env, invalid)).rejects.toThrow('invalid title');
    const staleEpochIntent = { admission: editAdmission('old-epoch', recovered.revision, 'Wrong epoch'),
      work: created.work, expectedHead: recovered.revision, title: 'Wrong epoch' };
    await expect(editMetadataWork({ ...env, lineage: { ...lineage, dataEpoch: Bun.randomUUIDv7() } },
      staleEpochIntent)).rejects.toBeInstanceOf(PendingActivation);
    const position = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?sequence }
    }`);
    expect(position.results?.bindings[0]?.sequence?.value).toBe('5');
    const missing = await readExactWorkRevision({ ...env,
      objectDirectory: join(state, 'missing-objects') }, firstHead, async () => true).catch(error => error);
    expect(missing).toBeInstanceOf(RevisionUnavailable);
    const corruptDirectory = join(state, 'corrupt-objects');
    cpSync(env.objectDirectory, corruptDirectory, { recursive: true });
    const manifest = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?manifest WHERE {
      GRAPH <urn:rezics:graph:revisions> { <${firstHead}> rv:manifest ?manifest }
    }`)).results?.bindings[0]?.manifest?.value!;
    const payloadManifest = JSON.parse(readFileSync(join(corruptDirectory, manifest.slice(-64)), 'utf8')) as { payload: string };
    const payloadHash = payloadManifest.payload.slice(7);
    writeFileSync(join(corruptDirectory, payloadHash), 'corrupt');
    await expect(readExactWorkRevision({ ...env, objectDirectory: corruptDirectory }, firstHead, async () => true))
      .rejects.toBeInstanceOf(RevisionCorrupt);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
