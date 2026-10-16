import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readSourceRunEvidence } from '../src/modules/source/run-evidence.ts';
import { readExternalReleaseRunEvidence, verifyExternalReleaseReference } from '../src/modules/source/external-release.ts';
import { OPEN_LIBRARY_WORKS_RUN, type SourceRunStore, type SourceRunView } from '../src/modules/source/acquisition-run.ts';
import { sourceRunExport } from '../src/modules/export/source-run.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const iri = (id = randomUUID()) => `https://rezics.com/id/${id}`;

function fixture() {
  const principal = randomUUID(), runId = randomUUID();
  const bytes = Buffer.from('{"size":2,"entries":[{"key":"/books/OL12M","authors":null},' +
    '{"key":"/books/OL11M","authors":[]}]}');
  const digest = sha(bytes), requestKey = 'GET /works/OL1W/editions.json?limit=25&offset=0';
  const run: SourceRunView = { profile: 'source-acquisition-run-v1', run: iri(runId),
    provider: 'open-library', acquisitionProfile: OPEN_LIBRARY_WORKS_RUN, state: 'completed', createdAt: '2026-10-16',
    completion: null, surfaces: [{ surface: 'editions', required: true, captureLimit: 1,
      retention: { requested: 'retained', effective: 'retained', terms: 'permitted', limited: false, termsReference: 'urn:terms' },
      outcome: { outcome: 'qualified', reason: 'complete', captureCount: 1, captureSetDigest: sha('set'),
        detail: {}, settledAt: '2026-10-16' },
      captures: [{ ordinal: 1, role: 'response', requestKey, observation: iri(), record: iri(), namespace: 'work-editions',
        externalId: 'OL1W', sourceRevision: null, retention: 'retained', byteDigest: digest,
        byteLength: bytes.length, url: 'https://openlibrary.org/works/OL1W/editions.json', fetchedAt: '2026-10-16' }] }] };
  let frozenBytes = bytes;
  const calls = { run: 0, frozen: 0 };
  const runs: Pick<SourceRunStore, 'read' | 'frozen'> = {
    read: async (owner, id) => { calls.run++; return owner === principal && id === runId ? run : null; },
    frozen: async (id, key) => { calls.frozen++; return id === runId && key === requestKey
      ? { id: randomUUID(), ordinal: 1, requestKey, status: 200, bytes: frozenBytes } : null; },
  };
  return { principal, runId, run, runs, bytes, calls, corrupt: () => { frozenBytes = Buffer.from('different'); } };
}

test('Source verifies an adapter reference against exact private frozen evidence and position', async () => {
  const f = fixture();
  const snapshot = await readExternalReleaseRunEvidence(f.runs, f.principal, f.runId);
  expect(f.calls).toEqual({ run: 1, frozen: 1 });
  expect(snapshot.releases.map(item => item.release)).toEqual(['open-library:edition:OL12M', 'open-library:edition:OL11M']);
  const link = { run: snapshot.run, release: snapshot.releases[0]!.release,
    sourceClaim: snapshot.releases[0]!.sourceClaim, expectedPosition: snapshot.position };
  expect(verifyExternalReleaseReference(snapshot, link)).toEqual(snapshot.releases[0]!);
  expect(() => verifyExternalReleaseReference(snapshot, { ...link, release: 'open-library:edition:OL99M' })).toThrow();
  expect(() => verifyExternalReleaseReference(snapshot, { ...link, sourceClaim: snapshot.releases[1]!.sourceClaim })).toThrow();
  expect(() => verifyExternalReleaseReference(snapshot, { ...link, expectedPosition: {
    ...snapshot.position, dataEpoch: '0'.repeat(64) } })).toThrow();
  await expect(readSourceRunEvidence(f.runs, randomUUID(), f.runId)).rejects.toThrow();
  f.corrupt();
  await expect(readSourceRunEvidence(f.runs, f.principal, f.runId)).rejects.toThrow();
});

test('capture export needs no provider interpretation and keeps unknown authorship byte-for-byte', async () => {
  const f = fixture();
  f.run.provider = 'another-admitted-provider';
  f.run.acquisitionProfile = 'opaque-capture-v1';
  const snapshot = await readSourceRunEvidence(f.runs, f.principal, f.runId);
  const plan = sourceRunExport(snapshot, iri(), 'evaluation');
  expect(plan.targetProfile).toBe('rezics-source-run-v1');
  expect(Buffer.from(plan.members[0]!.data!.rawBytesBase64 as string, 'base64')).toEqual(f.bytes);
  expect(plan.members[0]!.data!.sourceRevision).toBeNull();
  expect(JSON.stringify(plan)).not.toContain('creditedName');
  await expect(readExternalReleaseRunEvidence(f.runs, f.principal, f.runId)).rejects.toThrow('no admitted');
});

test('incomplete, refused, erased and over-budget captures fail before reading frozen bytes', async () => {
  for (const change of [
    (run: SourceRunView) => { run.state = 'incomplete'; },
    (run: SourceRunView) => { run.surfaces[0]!.outcome!.outcome = 'unqualified'; },
    (run: SourceRunView) => { run.surfaces[0]!.captures[0]!.retention = 'not-retained'; },
    (run: SourceRunView) => { run.surfaces[0]!.captures[0]!.byteLength = 262_145; },
  ]) {
    const f = fixture();
    change(f.run);
    await expect(readSourceRunEvidence(f.runs, f.principal, f.runId)).rejects.toThrow();
    expect(f.calls).toEqual({ run: 1, frozen: 0 });
  }
});
