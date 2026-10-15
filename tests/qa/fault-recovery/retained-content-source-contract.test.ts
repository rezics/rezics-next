import { expect, test } from 'bun:test';
import { sha256 } from '../../../scripts/fixture/corpus.ts';
import { OFFLINE_INDEX_SCRIPT } from '../../../scripts/operations/search-state.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady } from '../../../services/main/src/modules/work/search-readiness.ts';
import { PUBLIC, withRetainedContentCopy } from './retained-content-source-consumer.ts';

test('D016: retained Content reconstructs with isolated owner state and leaves its original and backup unchanged', async () => {
  await withRetainedContentCopy('valid', async copy => {
    const { stack, facts, lease, evidence, phase } = copy;
    await phase('baseline-owner-and-public-answers', async () => {
      const cut = await lease.candidate.content.ownerPosition();
      expect(cut).toEqual(facts.cut);
      expect((await lease.candidate.cursor.read(facts.consumer)).sequence).toBe(cut.sequence);
      const before = await copy.query(stack.fuseki);
      expect(before).toMatchObject({ complete: true, total: 1 });
      expect(before.results).toEqual(facts.before.results);
      const unit = facts.unit;
      const rows = facts.retainedFacts;
      const one = (graph: string, subject: string, predicate: string) => rows.filter(row =>
        row.g?.value === graph && row.s?.value === subject && row.p?.value === RV + predicate);
      for (const predicate of ['field', 'disclosure', 'language', 'variant', 'resource', 'revision',
        'publicationDecision', 'eligibility', 'projection', 'searchBody']) {
        expect(one(PUBLIC, unit, predicate)).toHaveLength(1);
      }
      expect(one(PUBLIC, unit, 'field')[0]!.o?.value).toBe(RV + 'Body');
      expect(one(PUBLIC, unit, 'disclosure')[0]!.o?.value).toBe(RV + 'Public');
      for (const predicate of ['byteDigest', 'ownerDataEpoch']) {
        expect(one(GRAPHS.revisions, facts.producer.content.publicationDecision, predicate)).toHaveLength(1);
      }
      const beforeApi = await copy.publicSearch(stack.fuseki);
      expect(beforeApi).toMatchObject({ status: 200, body: { complete: true, total: 1 } });
      expect(beforeApi).toEqual(facts.beforeApi);
      expect(lease.manifest.provenance.elapsedMs).toBeLessThan(600_000);
      Object.assign(evidence, { producer: facts.producer, cut, unit, retainedFacts: rows,
        before, beforeApi, baselinePosition: facts.position });
    });
    await phase('stop-restored-original', () => stack.runner.stop());
    const originalDump = await phase('original-rdf', () => copy.dump(stack.stateVolume));
    // Native dumps acquire locks: inspect writable copies, never retained custody.
    const inspect = await phase('backup-inspection-copy', () => copy.clone(facts.sourceVolumes.graph, 'inspect'));
    const backupDump = await phase('backup-rdf', () => copy.dump(inspect));
    const copyAt = Date.now();
    const volume = await phase('valid-graph-copy', () => copy.clone(facts.sourceVolumes.graph, 'valid'));
    expect(volume).not.toBe(facts.sourceVolumes.graph);
    expect(volume).not.toBe(stack.stateVolume);
    evidence.isolatedGraph = volume;
    evidence.indexLog = (await phase('offline-index', () => copy.offline(volume, OFFLINE_INDEX_SCRIPT))).slice(-4000);
    await phase('compatibility-startup-and-public-answers', async () => {
      const server = await copy.start(volume);
      const client = copy.client(server);
      const reconstructed = await copy.query(client);
      const ready = await assertPublicTextReady(client, facts.lineage);
      const reconstructedApi = await copy.publicSearch(client);
      Object.assign(evidence, { reconstructed, reconstructedApi, ready,
        health: await client.commandHealth(), delta: await client.searchDeltaSince('-1') });
      expect(reconstructed).toMatchObject({ complete: true, total: 1,
        results: [{ matchUnit: facts.unit, revision: facts.before.results[0]!.revision,
          publicationDecision: facts.producer.content.publicationDecision }] });
      expect(reconstructedApi).toMatchObject({ status: 200, body: { complete: true, total: 1,
        results: [{ matchUnit: facts.unit, revision: facts.before.results[0]!.revision,
          publicationDecision: facts.producer.content.publicationDecision }] } });
      expect(ready.generation).not.toBe(facts.position.generation);
      expect(ready.sequence).toBe(facts.position.sequence);
      await server.runner.stop();
    });
    evidence.copyElapsedMs = Date.now() - copyAt;
    expect(Date.now() - copyAt).toBeLessThan(600_000);
    await phase('backup-and-original-rdf-equality', async () => {
      const finalInspect = await copy.clone(facts.sourceVolumes.graph, 'final-inspect');
      expect(sha256(copy.dump(finalInspect))).toBe(sha256(backupDump));
      expect(copy.dump(stack.stateVolume)).toBe(originalDump);
      expect(sha256(copy.originalRdf())).toBe(lease.manifest.integrity.rdfDigest);
    });
    await phase('return-to-original', async () => {
      await stack.runner.start();
      expect(await copy.query(stack.fuseki)).toMatchObject({ complete: true, total: 1,
        results: [{ matchUnit: facts.unit }] });
    });
    await phase('final-backup-byte-equality', async () => {
      const final = await copy.store.select(copy.adapter);
      expect(final.integrity).toEqual(lease.manifest.integrity);
      expect(final.digest).toBe(lease.manifest.digest);
      evidence.isolationVerified = true;
      evidence.finalManifestDigest = final.digest;
      evidence.finalIntegrityDigest = final.integrity.digest;
    });
  });
}, qaStartupTestTimeout(360_000));
