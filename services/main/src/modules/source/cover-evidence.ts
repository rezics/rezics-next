import { createHash } from 'node:crypto';
import type { ImportedCoverProvenance } from '../media/typed-schema.ts';
import type { SourceIntakeStore, StagedSourceObservation } from './intake.ts';

export class SourceCoverEvidenceInvalid extends Error {}
export class SourceCoverEvidenceUnavailable extends Error {}

const ID = 'https://rezics.com/id/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type CoverEnvelope = {
  profile: 'source-cover-evidence-v1';
  source: {
    provider: string;
    namespace: string;
    externalId: string;
    sourceRevision: string | null;
    component: string | null;
    datasetSnapshotDigest: string;
    recordDigest: string;
    fieldLocator: string;
    displayName: string;
    href: string;
  };
  image: {
    captureUrl: string;
    captureDigest: string;
    byteLength: number;
    mediaType: string;
  };
  holderEvidence: { name: string; fieldLocator: string } | null;
};

function exactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function canonicalEnvelope(value: unknown): CoverEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SourceCoverEvidenceInvalid('cover evidence descriptor is invalid');
  }
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ['profile', 'source', 'image', 'holderEvidence'])
    || root.profile !== 'source-cover-evidence-v1'
    || !root.source || typeof root.source !== 'object' || Array.isArray(root.source)
    || !root.image || typeof root.image !== 'object' || Array.isArray(root.image)) {
    throw new SourceCoverEvidenceInvalid('cover evidence descriptor is invalid');
  }
  const source = root.source as Record<string, unknown>;
  const image = root.image as Record<string, unknown>;
  if (!exactKeys(source, ['provider', 'namespace', 'externalId', 'sourceRevision', 'component',
    'datasetSnapshotDigest', 'recordDigest', 'fieldLocator', 'displayName', 'href'])
    || !exactKeys(image, ['captureUrl', 'captureDigest', 'byteLength', 'mediaType'])) {
    throw new SourceCoverEvidenceInvalid('cover evidence descriptor is invalid');
  }
  const holderEvidence = root.holderEvidence;
  if (holderEvidence !== null && (!holderEvidence || typeof holderEvidence !== 'object'
    || Array.isArray(holderEvidence)
    || !exactKeys(holderEvidence as Record<string, unknown>, ['name', 'fieldLocator']))) {
    throw new SourceCoverEvidenceInvalid('cover holder evidence is invalid');
  }
  return value as CoverEnvelope;
}

function decodeObservation(observation: StagedSourceObservation): CoverEnvelope {
  if (observation.retention !== 'retained' || observation.mediaType !== 'application/json'
    || !observation.rawBytesBase64 || !observation.byteDigest || !SHA256.test(observation.byteDigest)
    || !Number.isSafeInteger(observation.byteLength) || observation.byteLength! > 65_536) {
    throw new SourceCoverEvidenceUnavailable('retained cover evidence is unavailable');
  }
  const bytes = Buffer.from(observation.rawBytesBase64, 'base64');
  if (bytes.length !== observation.byteLength || bytes.toString('base64') !== observation.rawBytesBase64
    || createHash('sha256').update(bytes).digest('hex') !== observation.byteDigest) {
    throw new SourceCoverEvidenceUnavailable('retained cover evidence digest differs');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new SourceCoverEvidenceInvalid('cover evidence envelope is invalid'); }
  return canonicalEnvelope(parsed);
}

/** Verifies the small retained descriptor through Source's principal-scoped read. */
export class SourceCoverEvidenceVerifier {
  constructor(private readonly intake: Pick<SourceIntakeStore, 'read'>) {}

  async verify(principalId: string, provenance: ImportedCoverProvenance): Promise<void> {
    const recordId = provenance.source.record.slice(ID.length);
    const observationId = provenance.source.observation.slice(ID.length);
    if (!UUID.test(principalId) || !UUID.test(recordId) || !UUID.test(observationId)) {
      throw new SourceCoverEvidenceInvalid('cover evidence identity is invalid');
    }
    let observation: StagedSourceObservation | null;
    try { observation = await this.intake.read(principalId, observationId); }
    catch { throw new SourceCoverEvidenceUnavailable('cover evidence is unavailable'); }
    if (!observation) throw new SourceCoverEvidenceInvalid('cover evidence is not owned by this principal');
    if (observation.record !== provenance.source.record
      || observation.observation !== provenance.source.observation
      || observation.provider !== provenance.source.provider
      || observation.namespace !== provenance.source.namespace
      || observation.externalId !== provenance.source.externalId
      || observation.sourceRevision !== provenance.source.sourceRevision
      || observation.byteDigest !== provenance.source.observationDigest) {
      throw new SourceCoverEvidenceInvalid('cover evidence identity differs');
    }
    const envelope = decodeObservation(observation);
    const expected: CoverEnvelope = {
      profile: 'source-cover-evidence-v1',
      source: {
        provider: provenance.source.provider,
        namespace: provenance.source.namespace,
        externalId: provenance.source.externalId,
        sourceRevision: provenance.source.sourceRevision,
        component: provenance.source.component,
        datasetSnapshotDigest: provenance.source.datasetSnapshotDigest,
        recordDigest: provenance.source.recordDigest,
        fieldLocator: provenance.source.fieldLocator,
        displayName: provenance.source.displayName,
        href: provenance.source.href,
      },
      image: {
        captureUrl: provenance.image.captureUrl,
        captureDigest: provenance.image.captureDigest,
        byteLength: provenance.image.byteLength,
        mediaType: provenance.image.mediaType,
      },
      holderEvidence: provenance.holderEvidence,
    };
    if (stable(envelope) !== stable(expected)
      || !SHA256.test(envelope.source.datasetSnapshotDigest)
      || !SHA256.test(envelope.source.recordDigest)
      || !SHA256.test(envelope.image.captureDigest)
      || envelope.image.captureDigest !== provenance.originalDigest
      || envelope.image.byteLength !== provenance.image.byteLength
      || envelope.image.mediaType !== provenance.image.mediaType) {
      throw new SourceCoverEvidenceInvalid('cover evidence descriptor differs from the retained observation');
    }
  }
}
