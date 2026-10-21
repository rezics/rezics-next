import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { ImportedArtNativeVerifier, type ImportedArtNativeBasis } from '../src/modules/media/imported-art.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Controlled owner boundaries exercise the verifier's conjunction and final
 * fences. Persisted Source/Media/Access behavior is covered by the owner suite. */
function scenario(role: 'portrait' | 'screenshot' = 'portrait') {
  const bytes = Buffer.from('original imported artwork'), sha256 = digest(bytes);
  const target = id(), component = id(), revision = id(), actor = id(), admissionId = randomUUID();
  const native: ImportedArtNativeBasis = { kind: 'media-use', target, component, revision,
    receipt: 'urn:rezics:receipt:exact-owner-command', variant: `urn:rezics:variant:${randomUUID()}`,
    role, context: 'https://rezics.com/context/default' };
  const row = { use: component, target, context: native.context, selection: revision, currentHead: revision,
    variant: native.variant, assetRevision: revision, asset: randomUUID(), actor, role: 'publication-item',
    operationId: `media-art:${admissionId}`, requestDigest: 'command-digest', dataEpoch: 'epoch', sequence: '17',
    objectNamespace: 'test/', original: { id: randomUUID(), sha256, byteLength: bytes.length },
    provenance: { format: 'media-imported-art-v2', targetWork: target, role, archive: null,
      originalDigest: sha256, source: { provider: 'bangumi', record: id(), observationDigest: 'observation',
        fieldLocator: '/images/large' }, image: { captureUrl: 'https://example.test/portrait.png', captureDigest: sha256 } } };
  const receipt = { receipt: native.receipt, admissionId, action: 'media.avatar', scope: `media:avatar:${target}`,
    actingSubject: actor, requestDigest: row.requestDigest, dataEpoch: row.dataEpoch, sequence: row.sequence };
  let current = row, currentBytes = bytes, available = true, sourceReads = 0;
  const media = { readImportedCoverUse: async () => current };
  const access = { activePrincipalId: async () => 'principal', readAcknowledgedOwnerCommand: async () => receipt };
  const source = { verifyCurrent: async () => { throw new Error('legacy Source must not verify v2'); } };
  const art = { source: { verifyCurrent: async () => { sourceReads++; if (!available) throw new Error('withdrawn'); } },
    rights: { currentMediaDelivery: async () => ({ status: 'assessed', assessment: {
      expressionKind: 'media', outcome: 'supported', basis: 'permission', extent: {
        originalDigest: sha256, observationDigest: row.provenance.source.observationDigest, fieldLocator: '/images/large' } } }) } };
  // Deliberately use the runtime constructor here so this first regression also
  // demonstrates the old verifier's unsupported-profile result before the v2 port exists.
  const Verifier = ImportedArtNativeVerifier as unknown as new (...args: unknown[]) => ImportedArtNativeVerifier;
  const verifier = new Verifier(media, access, source, () => ({ get: async () => currentBytes }), art);
  return { row, native, receipt, verifier, principal: {} as Parameters<ImportedArtNativeVerifier['verify']>[0],
    selected: { value: row.provenance.image.captureUrl, language: null },
    changeHead: () => { current = { ...row, currentHead: id() }; },
    corrupt: () => { currentBytes = Buffer.from('wrong bytes'); },
    withdraw: () => { available = false; }, reads: () => sourceReads };
}

test('revisioned portraits and screenshots retain exact native, Source, rights and original-byte proof', async () => {
  for (const role of ['portrait', 'screenshot'] as const) {
    const s = scenario(role);
    expect(await s.verifier.verify(s.principal, s.native, s.selected)).toMatchObject({ status: 'verified', native: s.native });
    expect(s.reads()).toBe(2);
  }
});

test('revisioned artwork does not accept changed heads, bytes, Source custody or another role', async () => {
  const stale = scenario(); stale.changeHead();
  expect(await stale.verifier.verify(stale.principal, stale.native, stale.selected)).toEqual({ status: 'mismatch', basis: 'native-head' });
  const corrupt = scenario(); corrupt.corrupt();
  expect(await corrupt.verifier.verify(corrupt.principal, corrupt.native, corrupt.selected)).toMatchObject({ status: 'unavailable' });
  const withdrawn = scenario(); withdrawn.withdraw();
  expect(await withdrawn.verifier.verify(withdrawn.principal, withdrawn.native, withdrawn.selected)).toMatchObject({ status: 'unavailable' });
  const wrongRole = scenario();
  expect(await wrongRole.verifier.verify(wrongRole.principal, { ...wrongRole.native, role: 'screenshot' }, wrongRole.selected))
    .toEqual({ status: 'mismatch', basis: 'native-target' });
});
