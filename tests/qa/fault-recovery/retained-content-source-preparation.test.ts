import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { RetainedSources, sourceKey } from '../../../scripts/qa/retained-source.ts';
import { prepareRetainedContentSource, retainedContentSourceAdapter, retainedContentSourceDirectory } from './retained-content-source-support.ts';
import { requireFaultTier } from './search-ops-support.ts';

test('D016: preparation publishes and verifies immutable complete Content source custody', async () => {
  const { artifacts } = requireFaultTier();
  const prepared = await prepareRetainedContentSource();
  const directory = retainedContentSourceDirectory();
  const adapter = retainedContentSourceAdapter(directory);
  const selected = await new RetainedSources(directory).select(adapter);
  const evidence = { sourceKey: selected.key, manifestDigest: selected.digest,
    integrityDigest: selected.integrity.digest, rdfDigest: selected.integrity.rdfDigest,
    manifestPath: selected.provenance.manifestPath, backupPath: selected.provenance.backupPath,
    producerRevision: selected.provenance.producerRevision, qaIdentity: selected.provenance.qaIdentity,
    image: selected.specification.compatibility.selectedNativeImage,
    built: prepared.built, buildCount: prepared.built ? 1 : 0, reuseCount: prepared.built ? 0 : 1,
    elapsedMs: prepared.elapsedMs, admissionWaitMs: prepared.admissionWaitMs,
    phases: selected.provenance.phases, sourceVolumes: selected.metadata.sourceVolumes };
  writeFileSync(join(artifacts, 'retained-content-source-preparation.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  expect(selected.key).toBe(sourceKey(adapter.specification));
  expect(selected.digest).toBe(prepared.manifest.digest);
  expect(selected.integrity.digest).toBe(prepared.manifest.integrity.digest);
  expect(prepared.elapsedMs).toBeLessThan(600_000);
}, qaStartupTestTimeout(600_000));
