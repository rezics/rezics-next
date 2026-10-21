import { createHash } from 'node:crypto';
import type { ImportedCoverProvenance } from '../media/typed-schema.ts';
import type { SourceIntakeStore, StagedSourceObservation } from './intake.ts';
import type { Pool } from 'pg';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { ExportBasis, VerifiedExportMember } from '../export/planner.ts';
import type { RightsStore } from '../rights/store.ts';
import type { SourceArchiveEvidenceOwner } from './archive-evidence.ts';

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
  constructor(private readonly intake: Pick<SourceIntakeStore, 'read'>, private readonly pool?: Pool) {}

  async verify(principalId: string, provenance: ImportedCoverProvenance): Promise<void> {
    return this.verifyObservation(principalId, provenance, false);
  }

  /** Current owner verification is opt-in; legacy intake-only composition
   * cannot assert that an observation has survived withdrawal or erasure. */
  async verifyCurrent(principalId: string, provenance: ImportedCoverProvenance): Promise<void> {
    if (!this.pool) throw new SourceCoverEvidenceUnavailable('current Source owner is unavailable');
    return this.verifyObservation(principalId, provenance, true);
  }

  private async verifyObservation(principalId: string, provenance: ImportedCoverProvenance, current: boolean): Promise<void> {
    const recordId = provenance.source.record.slice(ID.length);
    const observationId = provenance.source.observation.slice(ID.length);
    if (!UUID.test(principalId) || !provenance.source.record.startsWith(ID)
      || !provenance.source.observation.startsWith(ID) || !UUID.test(recordId) || !UUID.test(observationId)) {
      throw new SourceCoverEvidenceInvalid('cover evidence identity is invalid');
    }
    let observation: StagedSourceObservation | null;
    try { observation = current
      ? await readCurrentSourceObservation(this.pool!, this.intake, principalId, provenance.source.observation)
      : await this.intake.read(principalId, observationId); }
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
    if (current) {
      const after = await readCurrentSourceObservation(this.pool!, this.intake, principalId, provenance.source.observation);
      if (!after || after.record !== observation.record || after.byteDigest !== observation.byteDigest) {
        throw new SourceCoverEvidenceUnavailable('current cover evidence changed');
      }
    }
  }
}

/** Revisioned artwork evidence consumes original provider responses or the
 * archive owner's binary/COPY witness. A URL descriptor is never archive custody. */
export class SourceMediaEvidenceVerifier {
  constructor(private readonly intake: Pick<SourceIntakeStore, 'read'>, private readonly pool: Pool,
    private readonly access: Pick<AccessAdmissionRegistry, 'activePrincipalId'>,
    private readonly archives: Pick<SourceArchiveEvidenceOwner, 'verify'>) {}

  async verifyCurrent(principal: VerifiedPrincipal, provenance: ImportedCoverProvenance): Promise<void> {
    const principalId = await this.access.activePrincipalId(principal);
    if (!principalId) throw new SourceCoverEvidenceUnavailable('Source principal is unavailable');
    if (provenance.format === 'media-imported-cover-v1') {
      if (provenance.source.provider === 'vndb') throw new SourceCoverEvidenceInvalid('VNDB requires original archive custody');
      return new SourceCoverEvidenceVerifier(this.intake, this.pool).verifyCurrent(principalId, provenance);
    }
    if (provenance.source.provider === 'vndb') {
      if (!provenance.archive) throw new SourceCoverEvidenceInvalid('VNDB archive witness is required');
      const witness = await this.archives.verify(principal, provenance.archive.admission, provenance.archive.coordinate);
      const source = provenance.source;
      if (witness.source.record !== source.record || witness.source.observation !== source.observation
        || witness.source.observationDigest !== source.observationDigest || witness.source.provider !== source.provider
        || witness.source.namespace !== source.namespace || witness.source.externalId !== source.externalId
        || witness.source.sourceRevision !== source.sourceRevision || witness.row.role !== provenance.role
        || witness.row.rowDigest !== source.recordDigest || witness.row.fieldLocator !== source.fieldLocator
        || witness.row.imageUrl !== provenance.image.captureUrl) {
        throw new SourceCoverEvidenceInvalid('archive/COPY artwork identity differs');
      }
      if (provenance.holderEvidence && pointer(witness.row.decodedRow, provenance.holderEvidence.fieldLocator)
        !== provenance.holderEvidence.name) throw new SourceCoverEvidenceInvalid('artwork holder field differs');
    } else if (provenance.source.provider === 'bangumi' && provenance.archive === null) {
      const observation = await readCurrentSourceObservation(this.pool, this.intake, principalId, provenance.source.observation);
      if (!observation || observation.record !== provenance.source.record
        || observation.provider !== provenance.source.provider || observation.namespace !== provenance.source.namespace
        || observation.externalId !== provenance.source.externalId || observation.sourceRevision !== provenance.source.sourceRevision
        || observation.byteDigest !== provenance.source.observationDigest || observation.retention !== 'retained'
        || observation.mediaType !== 'application/json' || !observation.rawBytesBase64
        || observation.byteLength === null || observation.byteLength > 262_144) {
        throw new SourceCoverEvidenceUnavailable('original provider response is unavailable');
      }
      const bytes = Buffer.from(observation.rawBytesBase64, 'base64');
      if (bytes.length !== observation.byteLength || bytes.toString('base64') !== observation.rawBytesBase64
        || createHash('sha256').update(bytes).digest('hex') !== provenance.source.observationDigest
        || provenance.source.recordDigest !== provenance.source.observationDigest) {
        throw new SourceCoverEvidenceInvalid('provider response digest differs');
      }
      let response: { id?: unknown; images?: { large?: unknown } };
      try { response = JSON.parse(bytes.toString('utf8')) as typeof response; }
      catch { throw new SourceCoverEvidenceInvalid('invalid provider response'); }
      const kind = provenance.role === 'portrait' ? 'characters' : provenance.role === 'cover' ? 'subjects' : null;
      const namespace = provenance.role === 'portrait' ? 'character' : 'subject';
      const endpoint = observation.capture
        ? /^https:\/\/api\.bgm\.tv\/v0\/(subjects|characters)\/([1-9][0-9]*)$/.exec(observation.capture.url) : null;
      // The returned ID may be canonical after a subject merge; the endpoint's
      // requested ID remains retained rather than silently rewritten.
      if (!kind || observation.namespace !== namespace
        || observation.capture && (!endpoint || endpoint[1] !== kind || endpoint[2] !== observation.externalId)
        || !response || !Number.isSafeInteger(response.id)
        || Number(response.id) < 1 || provenance.source.fieldLocator !== '/images/large'
        || !observation.capture && String(response.id) !== observation.externalId
        || response.images?.large !== provenance.image.captureUrl) {
        throw new SourceCoverEvidenceInvalid('provider entity, role or field differs');
      }
      if (provenance.holderEvidence && pointer(response, provenance.holderEvidence.fieldLocator)
        !== provenance.holderEvidence.name) throw new SourceCoverEvidenceInvalid('artwork holder field differs');
      const after = await readCurrentSourceObservation(this.pool, this.intake, principalId, provenance.source.observation);
      if (!after || after.record !== observation.record || after.byteDigest !== observation.byteDigest)
        throw new SourceCoverEvidenceUnavailable('provider evidence changed');
    } else throw new SourceCoverEvidenceInvalid('unsupported imported artwork evidence');
    if (provenance.originalDigest !== provenance.image.captureDigest
      || await this.access.activePrincipalId(principal) !== principalId)
      throw new SourceCoverEvidenceUnavailable('artwork evidence authority changed');
  }

  /** A disclosed native Media Use already carries its admitted immutable Source
   * coordinates. Delivery checks their current availability without borrowing
   * the importing principal or granting a visitor access to retained bytes. It
   * is not a new Source attribution or an archive admission. */
  async verifyDelivery(provenance: ImportedCoverProvenance): Promise<void> {
    if (provenance.format !== 'media-imported-art-v2') throw new SourceCoverEvidenceInvalid('revisioned artwork is required');
    const coordinates = [{ record: provenance.source.record, observation: provenance.source.observation,
      byteDigest: provenance.source.observationDigest }];
    let archive: { principal_id: string; record_id: string; observation_id: string; observation_digest: string;
      parts: Array<{ record: string; observation: string; byteDigest: string }> } | undefined;
    if (provenance.archive) {
      archive = (await this.pool.query(`SELECT principal_id,record_id,observation_id,observation_digest,parts
        FROM source.archive_admission WHERE id=$1`, [provenance.archive.admission.slice(ID.length)])).rows[0];
      if (!archive || `${ID}${archive.record_id}` !== provenance.source.record
        || `${ID}${archive.observation_id}` !== provenance.source.observation
        || archive.observation_digest !== provenance.source.observationDigest)
        throw new SourceCoverEvidenceUnavailable('admitted archive is unavailable');
      coordinates.push(...archive.parts);
    }
    const rows = (await this.pool.query<{ id: string; record_id: string; principal_id: string; byte_digest: string;
      provider: string; namespace: string; external_id: string; source_revision: string | null;
      state: string; erased: boolean; retained: boolean }>(`SELECT o.id,o.record_id,o.principal_id,o.byte_digest,
        r.provider,r.namespace,r.external_id,o.source_revision,COALESCE(d.state,'available') AS state,
        o.source_erasure_id IS NOT NULL AS erased,o.retention='retained' AND o.raw_bytes IS NOT NULL AS retained
      FROM source.observation o JOIN source.record r ON r.id=o.record_id
      LEFT JOIN verification.observation_disposition_head h ON h.observation_id=o.id
      LEFT JOIN verification.observation_disposition d ON d.id=h.head AND d.observation_id=o.id
      WHERE o.id=ANY($1::uuid[])`, [[...new Set(coordinates.map(item => item.observation.slice(ID.length)))]] )).rows;
    for (const coordinate of coordinates) {
      const row = rows.find(item => `${ID}${item.id}` === coordinate.observation);
      if (!row || `${ID}${row.record_id}` !== coordinate.record || row.byte_digest !== coordinate.byteDigest
        || row.erased || !row.retained || row.state !== 'available' || archive && row.principal_id !== archive.principal_id)
        throw new SourceCoverEvidenceUnavailable('artwork Source custody is unavailable');
    }
    const first = rows.find(item => `${ID}${item.id}` === provenance.source.observation)!;
    if (first.provider !== provenance.source.provider || first.namespace !== provenance.source.namespace
      || first.external_id !== provenance.source.externalId || first.source_revision !== provenance.source.sourceRevision)
      throw new SourceCoverEvidenceUnavailable('artwork Source identity changed');
  }
}

export interface RetainedEvidenceCoordinate {
  record: string;
  observation: string;
  fieldLocator: string;
  /** A pointer to retained language metadata; an absent tag remains null. */
  languageLocator?: string;
}
export interface RetainedEvidenceProjection {
  representation: { sha256: string; byteLength: number; mediaType: string };
  locator: { field: string };
  attribution: { provider: string; namespace: string; externalId: string;
    sourceRevision: string | null; captureUrl: string | null };
  language: string | null;
  quote: string | null;
  quoteWithheld: boolean;
  rights: ExportBasis | null;
}

/** The internal row never escapes through the retained-evidence projection. */
export async function readCurrentSourceObservation(pool: Pool,
  intake: Pick<SourceIntakeStore, 'read'>, principalId: string, observation: string):
  Promise<StagedSourceObservation | null> {
  if (!UUID.test(principalId) || !observation.startsWith(ID) || !UUID.test(observation.slice(ID.length))) {
    throw new SourceCoverEvidenceInvalid('invalid retained evidence identity');
  }
  const current = async () => (await pool.query<{ head: string | null; state: string; erased: boolean }>(`
    SELECT h.head::text,COALESCE(d.state,'available') AS state,o.source_erasure_id IS NOT NULL AS erased
    FROM source.observation o
    LEFT JOIN verification.observation_disposition_head h ON h.observation_id=o.id
    LEFT JOIN verification.observation_disposition d ON d.id=h.head AND d.observation_id=o.id
    WHERE o.id=$1 AND o.principal_id=$2`, [observation.slice(ID.length), principalId])).rows[0] ?? null;
  try {
    const before = await current();
    if (!before || before.erased || before.state !== 'available') return null;
    const retained = await intake.read(principalId, observation.slice(ID.length));
    const after = await current();
    if (!after || JSON.stringify(before) !== JSON.stringify(after)) return null;
    return retained;
  } catch { throw new SourceCoverEvidenceUnavailable('current retained evidence is unavailable'); }
}

function pointer(root: unknown, path: string): unknown {
  if (path.length > 2048 || !path.startsWith('/') || /~(?![01])/.test(path)) {
    throw new SourceCoverEvidenceInvalid('invalid retained evidence locator');
  }
  let value = root;
  for (const encoded of path.slice(1).split('/')) {
    const part = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)
      || Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Principal-owned evidence only. Public Source support disclosure stays with
 * the Source read owner; possession of this projection grants no public read. */
export class SourceRetainedEvidenceReader {
  constructor(private readonly pool: Pool,
    private readonly intake: Pick<SourceIntakeStore, 'read'>,
    private readonly access: Pick<AccessAdmissionRegistry, 'activePrincipalId'>,
    private readonly rights?: Pick<RightsStore, 'exportScope'>) {}

  async read(principal: VerifiedPrincipal, coordinate: RetainedEvidenceCoordinate):
    Promise<RetainedEvidenceProjection | null> {
    const principalId = await this.access.activePrincipalId(principal);
    if (!principalId) return null;
    const observation = await readCurrentSourceObservation(this.pool, this.intake, principalId, coordinate.observation);
    if (!observation || observation.record !== coordinate.record) return null;
    if (observation.retention !== 'retained' || observation.mediaType !== 'application/json'
      || !observation.rawBytesBase64 || !observation.byteDigest || observation.byteLength === null) {
      throw new SourceCoverEvidenceUnavailable('retained JSON representation is unavailable');
    }
    const bytes = Buffer.from(observation.rawBytesBase64, 'base64');
    if (bytes.length !== observation.byteLength || bytes.toString('base64') !== observation.rawBytesBase64
      || createHash('sha256').update(bytes).digest('hex') !== observation.byteDigest) {
      throw new SourceCoverEvidenceUnavailable('retained representation digest differs');
    }
    let document: unknown;
    try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new SourceCoverEvidenceUnavailable('retained JSON representation is invalid'); }
    const value = pointer(document, coordinate.fieldLocator);
    if (value === undefined) return null;
    const language = coordinate.languageLocator === undefined ? null : pointer(document, coordinate.languageLocator);
    if (!(language === null || typeof language === 'string' && language.length <= 35 && language.trim())) {
      throw new SourceCoverEvidenceUnavailable('retained language metadata is unavailable');
    }
    const member: VerifiedExportMember = {
      sourceOwner: 'source', sourceNamespace: observation.namespace, sourceGrain: 'source_observation',
      exactRef: observation.observation, contentRevisionId: null, refDigest: observation.byteDigest,
      ownerDataEpoch: 'source-observation-v1', ownerSequence: '0', sourcePosition: null,
      targetGrain: 'evidence', mapping: 'exact', data: { rightsIdentity: {
        material: { scopeKind: 'source_record', provider: null, namespace: null,
          sourceRecordId: observation.record.slice(ID.length), contentVariantId: null, mediaAsset: null, component: 'record' },
        target: { owner: 'source', resource: observation.record, component: 'record', revision: observation.observation },
      } },
    };
    const assess = async () => {
      if (!this.rights) return null;
      const bases = await this.rights.exportScope([member], 'quotation');
      if (bases.length !== 1 || bases[0]!.memberOrdinals.length !== 1 || bases[0]!.memberOrdinals[0] !== 1) {
        throw new SourceCoverEvidenceUnavailable('retained quotation rights are unavailable');
      }
      return bases[0]!;
    };
    const basis = await assess();
    // No positive citation survives a withdrawal, account deactivation or a
    // changed quotation assessment during this read. No transaction is claimed.
    const currentBasis = await assess();
    const current = await readCurrentSourceObservation(this.pool, this.intake, principalId, coordinate.observation);
    if (!current || current.byteDigest !== observation.byteDigest
      || await this.access.activePrincipalId(principal) !== principalId
      || JSON.stringify(basis) !== JSON.stringify(currentBasis)) return null;
    if (basis?.obligations.includes('access_restriction')) return null;
    const quoteWithheld = basis?.result !== 'supported' || typeof value !== 'string';
    return { representation: { sha256: observation.byteDigest, byteLength: bytes.length, mediaType: observation.mediaType },
      locator: { field: coordinate.fieldLocator },
      attribution: { provider: observation.provider, namespace: observation.namespace, externalId: observation.externalId,
        sourceRevision: observation.sourceRevision, captureUrl: observation.capture?.url ?? null },
      language, quote: quoteWithheld ? null : value as string, quoteWithheld, rights: basis };
  }
}
