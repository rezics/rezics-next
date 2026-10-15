import type { Pool } from 'pg';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { RealmReplyStore } from '../realm-reply/store.ts';
import { GLOBAL_CONTEXT } from './schema.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/contract.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { resolveRealmProfile } from '../space/policy.ts';
import { readExactMainRevision, readExactWorkRevision, RevisionNotFound } from '../work/history.ts';
import { CompositionCorrupt, CompositionUnavailable, readCompositionHeader } from '../structure/graph.ts';
import { readCompositionPage } from '../structure/read.ts';
import { semanticResourceTypeRole } from '../semantic/change.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../structure/tree.ts';
import { type CapturedEvidence, type EvidenceCapture, type EvidenceTarget, GovernanceDenied, GovernanceInvalid,
  GovernanceUnavailable, sha256, type TargetHeads } from './store.ts';

const agent = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const graphAnchor = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}(?:-agent-revision)?$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sourceId = (value: string): string | null => {
  const id = value.startsWith('https://rezics.com/id/') ? value.slice('https://rezics.com/id/'.length) : value;
  return uuid.test(id) ? id : null;
};

export interface EvidenceOwners {
  reply?: ReplyEvidenceOwner;
  /** Content bodies: exact revision bytes, authorized for the reporter's acting Agent. */
  content?: { core: Pick<ContentCore, 'readExactBatch'>;
    canRead: (principal: VerifiedPrincipal, actingSubject: string, revisionIds: readonly string[]) =>
      Promise<ReadonlySet<string>> };
  /** Graph Work titles/names and Main Version bodies through the exact revision readers. */
  graph?: { env: WorkActivationEnvironment;
    canReadWork: (principal: VerifiedPrincipal, actingSubject: string, work: string) => Promise<boolean> };
  /** Source observations: exact retained bytes or an explicit non-retention. */
  source?: (principal: VerifiedPrincipal, recordId: string, observationId: string) =>
    Promise<{ record: string; retention: 'retained' | 'not-retained'; byteDigest: string | null;
      mediaType: string } | null>;
  /** Content-owned immutable Use and its exact asset revision/representation. */
  media?: { pool: Pool;
    canReadWork: (principal: VerifiedPrincipal, actingSubject: string, work: string) => Promise<boolean>;
    isServedAvatar?: (work: string, use: string) => Promise<boolean> };
}

export interface ReplyEvidenceOwner {
  pool: Pick<Pool, 'query'>;
  reader: Pick<RealmReplyStore, 'readPublic'>;
  core: Pick<ContentCore, 'readExactBatch'>;
}

/** A known reply never falls through Work or graph-only placement authority.
 * Only target resolution may choose the current revision; evidence intake pins
 * the revision supplied by its caller. Context is retained, never a permit. */
export async function captureReplyEvidence(owner: ReplyEvidenceOwner, target: EvidenceTarget,
  principal: VerifiedPrincipal | null, actor?: string, resolveCurrent = false): Promise<CapturedEvidence | null> {
  try {
    const known = await owner.pool.query(`SELECT 1 FROM content.reply_author WHERE reply = $1
      UNION ALL SELECT 1 FROM content.reply WHERE id = $1 LIMIT 1`, [target.resource]);
    if (!known.rowCount) return null;
    if (target.owner !== 'content' || target.component !== 'body' || target.locator !== null
      || (!resolveCurrent || target.revision !== null) && (!target.revision || !uuid.test(target.revision))) {
      throw new GovernanceInvalid('Reply evidence needs an exact body revision');
    }
    const reply = await owner.reader.readPublic(target.resource, principal ?? undefined, actor);
    if (!reply || reply.reply !== target.resource || target.revision !== null && reply.revisionId !== target.revision) {
      throw new GovernanceDenied('Reported reply is unavailable');
    }
    const [exact] = await owner.core.readExactBatch([reply.revisionId], async ids => new Set(ids));
    if (!exact || exact.status !== 'available' || exact.reference.resourceId !== reply.reply
      || exact.reference.variantId !== reply.variantId || exact.reference.revisionId !== reply.revisionId
      || exact.reference.byteDigest !== reply.revisionDigest) {
      throw new GovernanceUnavailable('Exact reply evidence is unavailable');
    }
    const same = (current: typeof reply | null) => current && current.reply === reply.reply
      && current.revisionId === reply.revisionId && current.revisionDigest === reply.revisionDigest
      && current.variantId === reply.variantId && current.originRealm === reply.originRealm
      && current.rootTarget === reply.rootTarget && current.rootRevision === reply.rootRevision;
    // An anonymous reread certifies public authority for both root and origin.
    // A private result needs a final signed fence after the exact byte read.
    const publicReply = await owner.reader.readPublic(target.resource);
    const publiclyReadable = !!same(publicReply);
    if (!publiclyReadable && (!principal || !actor
      || !same(await owner.reader.readPublic(target.resource, principal, actor)))) {
      throw new GovernanceDenied('Reported reply changed or is unavailable');
    }
    return { owner: 'content', resource: reply.reply, component: 'body', locator: null,
      revision: reply.revisionId, revisionDigest: exact.reference.byteDigest, state: 'available',
      representation: exact.reference.format, provenance: { capturedBy: 'reply-exact-read-v1',
        author: reply.author, realm: reply.originRealm ?? GLOBAL_CONTEXT, root: reply.rootTarget,
        rootRevision: reply.rootRevision, variant: reply.variantId,
        disclosure: publiclyReadable ? 'public' : 'private' } };
  } catch (error) {
    if (error instanceof GovernanceInvalid || error instanceof GovernanceDenied || error instanceof GovernanceUnavailable) throw error;
    throw new GovernanceUnavailable('Reply evidence authority is unavailable', { cause: error });
  }
}

const result = (target: EvidenceTarget, state: CapturedEvidence['state'], revisionDigest: string | null,
  representation: string | null, via: string): CapturedEvidence => ({ ...target, state, revisionDigest,
  representation, provenance: { capturedBy: via } });

async function captureMediaUseEvidence(owner: NonNullable<EvidenceOwners['media']>, target: EvidenceTarget,
  actingSubject: string | null, canReadWork: () => Promise<boolean>, requireServedAvatar = false): Promise<CapturedEvidence> {
  if (target.owner !== 'media' || target.component !== 'media_use' || !agent.test(target.resource)
    || !target.revision || !uuid.test(target.revision) || !target.locator || !uuid.test(target.locator)) {
    throw new GovernanceInvalid('media use evidence needs its target, exact asset revision and Use');
  }
  try {
    if (!await canReadWork()) throw new GovernanceDenied('reporter cannot read the reported media target');
    if (requireServedAvatar && (!owner.isServedAvatar
      || !await owner.isServedAvatar(target.resource, target.locator))) {
      throw new GovernanceDenied('reported cover is unavailable');
    }
    const row = (await owner.pool.query<{ asset_id: string; asset_revision_id: string;
      representation_id: string; byte_digest: string; media_type: string; representation_availability: string;
      revision_availability: string; context: string; role: string; crop: string | null;
      disclosure: string; lifecycle: string; owner: string; served_use: string | null }>(
      `SELECT u.asset_id::text, u.asset_revision_id::text, u.representation_id::text,
         r.byte_digest, r.media_type, r.availability AS representation_availability,
         v.availability AS revision_availability, u.context, u.role, u.crop, s.disclosure, s.lifecycle,
         a.owner, served.use_id::text AS served_use
       FROM media.use u JOIN media.asset a ON a.id = u.asset_id
       JOIN media.asset_state s ON s.id = a.state_head
       JOIN media.representation r ON r.id = u.representation_id AND r.asset_id = u.asset_id
       JOIN content.revision v ON v.id = u.asset_revision_id AND v.variant_id = u.asset_variant_id
       LEFT JOIN media.selection_slot slot ON slot.target = u.target AND slot.context = u.context
         AND slot.role = 'avatar'
       LEFT JOIN media.selection_revision served ON served.id = media.delivered_selection(slot)
       WHERE u.id = $1 AND u.target = $2 AND u.asset_revision_id = $3`,
    [target.locator, target.resource, target.revision])).rows[0];
    if (!row) return result(target, 'unavailable', null, null, 'media-exact-use-v1');
    if (requireServedAvatar && (row.role !== 'avatar' || row.context !== DEFAULT_MEDIA_CONTEXT
      || row.served_use !== target.locator)) {
      return result(target, 'unavailable', null, null, 'media-exact-use-v1');
    }
    if (row.disclosure !== 'public' && row.owner !== actingSubject) {
      throw new GovernanceDenied('reporter cannot read the reported media asset');
    }
    if (row.lifecycle === 'erased' || row.revision_availability === 'erased'
      || row.representation_availability === 'erased') {
      return result(target, 'erased', null, null, 'media-exact-use-v1');
    }
    if (row.lifecycle !== 'active' || row.revision_availability !== 'available'
      || row.representation_availability !== 'available') {
      return result(target, 'unavailable', null, null, 'media-exact-use-v1');
    }
    return result(target, 'available', sha256(JSON.stringify([target.locator, target.resource,
      row.asset_id, row.asset_revision_id, row.representation_id, row.byte_digest,
      row.context, row.role, row.crop])), row.media_type, 'media-exact-use-v1');
  } catch (error) {
    if (error instanceof GovernanceInvalid || error instanceof GovernanceDenied || error instanceof GovernanceUnavailable) {
      throw error;
    }
    throw new GovernanceUnavailable('Media evidence owner is unavailable', { cause: error });
  }
}

/**
 * Captures exactly the named grain from its owner. A component without an
 * admitted exact reader is `unsupported`; no body is fabricated for
 * metadata-only objects and no current head replaces a named revision.
 */
export function ownerEvidenceCapture(owners: EvidenceOwners): EvidenceCapture & {
  /** Internal intake only, after resolveTargets has admitted this exact target. */
  admitted(target: EvidenceTarget, admission?: { actingSubject?: string; mediaWorkRead?: boolean;
    requireServedAvatar?: boolean }): Promise<CapturedEvidence>;
} {
  return {
    async admitted(target, admission) {
      if (target.owner === 'graph' && owners.graph && target.revision && graphAnchor.test(target.revision)) {
        if (target.component === 'title' || target.component === 'synopsis') {
          try {
            const exact = await readExactWorkRevision(owners.graph.env, target.revision,
              async work => work === target.resource);
            if (target.component === 'synopsis') return result(target, exact.description ? 'available' : 'unavailable',
              exact.description ? sha256(JSON.stringify([exact.revision, exact.work, exact.description])) : null,
              'work-synopsis', 'graph-exact-work-revision-v1');
            return result(target, 'available', sha256(JSON.stringify([exact.revision, exact.work, exact.title,
              exact.language])), 'work-title-en', 'graph-exact-work-revision-v1');
          } catch (error) {
            if (error instanceof RevisionNotFound) return result(target, 'unavailable', null, null, 'graph-exact-work-revision-v1');
            throw error;
          }
        }
        const rows = (await owners.graph.env.fuseki.query(`SELECT ?p ?o WHERE {
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(target.revision)} ?p ?o }
        } ORDER BY ?p ?o LIMIT 129`)).results?.bindings ?? [];
        if (rows.length > 128) throw new GovernanceUnavailable('Evidence anchor exceeds its bound');
        if (!rows.length) return result(target, 'unavailable', null, null, 'graph-exact-anchor-v1');
        return result(target, 'available', sha256(JSON.stringify(rows)), 'graph-anchor-v1', 'graph-exact-anchor-v1');
      }
      if (target.owner === 'content' && owners.content && target.revision) {
        const [read] = await owners.content.core.readExactBatch([target.revision], async ids => new Set(ids));
        if (!read || read.status === 'denied') throw new GovernanceUnavailable('Evidence owner is unavailable');
        if (read.status === 'available') {
          if (read.reference.resourceId !== target.resource) throw new GovernanceInvalid('Evidence revision belongs to another target');
          return result(target, 'available', read.reference.byteDigest, read.reference.format, 'content-exact-read-v1');
        }
        return result(target, read.status === 'erased' ? 'erased' : 'unavailable', null, null, 'content-exact-read-v1');
      }
      if (target.owner === 'media' && target.component === 'media_use' && owners.media) {
        return captureMediaUseEvidence(owners.media, target, admission?.actingSubject ?? null,
          async () => admission?.mediaWorkRead === true, admission?.requireServedAvatar === true);
      }
      return result({ ...target, revision: null }, 'unsupported', null, null, 'no-admitted-exact-reader');
    },
    async capture(principal, actingSubject, target) {
      if (target.owner === 'content' && owners.reply) {
        const reply = await captureReplyEvidence(owners.reply, target, principal, actingSubject);
        if (reply) return reply;
      }
      if (target.owner === 'content' && target.component === 'body' && owners.content) {
        if (!target.revision || !uuid.test(target.revision)) throw new GovernanceInvalid('content evidence needs a revision');
        const [read] = await owners.content.core.readExactBatch([target.revision],
          ids => owners.content!.canRead(principal, actingSubject, ids));
        if (!read || read.status === 'denied') throw new GovernanceDenied('reporter cannot read the reported revision');
        if (read.status === 'available') {
          if (read.reference.resourceId !== target.resource) throw new GovernanceInvalid('revision belongs to another resource');
          return result(target, 'available', read.reference.byteDigest, read.reference.format, 'content-exact-read-v1');
        }
        return result(target, read.status === 'erased' ? 'erased' : 'unavailable', null, null, 'content-exact-read-v1');
      }
      if (target.owner === 'graph' && owners.graph && ['title', 'name', 'synopsis'].includes(target.component)) {
        if (!target.revision || !agent.test(target.revision) || !agent.test(target.resource)) {
          throw new GovernanceInvalid('graph evidence needs a Work and revision');
        }
        if (!await owners.graph.canReadWork(principal, actingSubject, target.resource)) {
          throw new GovernanceDenied('reporter cannot read the reported Work');
        }
        try {
          const exact = await readExactWorkRevision(owners.graph.env, target.revision, async work =>
            work === target.resource);
          if (target.component === 'synopsis') return result(target, exact.description ? 'available' : 'unavailable',
            exact.description ? sha256(JSON.stringify([exact.revision, exact.work, exact.description])) : null,
            'work-synopsis', 'graph-exact-work-revision-v1');
          return result(target, 'available', sha256(JSON.stringify([exact.revision, exact.work, exact.title,
            exact.language])), 'work-title-en', 'graph-exact-work-revision-v1');
        } catch (error) {
          if (error instanceof RevisionNotFound) return result(target, 'unavailable', null, null, 'graph-exact-work-revision-v1');
          throw error;
        }
      }
      if (target.owner === 'graph' && owners.graph && target.component === 'body') {
        // resource = Main Version, revision = its exact revision; a metadata-only selection is empty.
        if (!target.revision || !agent.test(target.revision) || !agent.test(target.resource)) {
          throw new GovernanceInvalid('Main Version evidence needs a revision');
        }
        try {
          const exact = await readExactMainRevision(owners.graph.env, target.resource, target.revision,
            work => owners.graph!.canReadWork(principal, actingSubject, work));
          return exact.defaultSelection === null
            ? result(target, 'empty', null, 'metadata-only', 'graph-exact-main-revision-v1')
            : result(target, 'available', sha256(JSON.stringify([exact.revision, exact.defaultSelection])),
              'main-selection', 'graph-exact-main-revision-v1');
        } catch (error) {
          if (error instanceof RevisionNotFound) throw new GovernanceDenied('reporter cannot read the Main Version');
          throw error;
        }
      }
      if (target.owner === 'graph' && owners.graph && target.component === 'structure') {
        if (!target.revision || !agent.test(target.resource) || !agent.test(target.revision)
          || target.locator !== null && !agent.test(target.locator)) {
          throw new GovernanceInvalid('structure evidence needs an exact revision and optional occurrence');
        }
        const header = await readCompositionHeader(owners.graph.env, target.resource);
        if (!header) return result(target, 'unavailable', null, null, 'structure-exact-revision-v1');
        if (!await owners.graph.canReadWork(principal, actingSubject, header.work)) {
          throw new GovernanceDenied('reporter cannot read the reported structure');
        }
        let undisclosed = false;
        try {
          const page = await readCompositionPage(owners.graph.env, {
            structure: target.resource, revision: target.revision,
            ...(target.locator ? { occurrence: target.locator } : {}), limit: 1,
            canReadTarget: async work => {
              const allowed = await owners.graph!.canReadWork(principal, actingSubject, work);
              if (!allowed) undisclosed = true;
              return allowed;
            },
          });
          if (undisclosed) throw new GovernanceDenied('reporter cannot read the reported occurrence');
          if (!target.locator && page.placementCount === 0) {
            return result(target, 'empty', null, 'structure-empty-v1', 'structure-exact-revision-v1');
          }
          const record = target.locator ? page.occurrences[0] : null;
          if (target.locator && !record) return result(target, 'unavailable', null, null,
            'structure-exact-revision-v1');
          return result(target, record?.state === 'removed' ? 'empty' : 'available',
            sha256(JSON.stringify([page.structure, page.revision, record ?? page.placementCount])),
            record ? 'structure-occurrence-v1' : 'structure-revision-v1', 'structure-exact-revision-v1');
        } catch (error) {
          if (error instanceof GovernanceDenied) throw error;
          if (error instanceof CompositionUnavailable || error instanceof StructureObjectUnavailable) {
            return result(target, 'unavailable', null, null, 'structure-exact-revision-v1');
          }
          if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt) {
            throw new GovernanceUnavailable('structure evidence is corrupt');
          }
          throw error;
        }
      }
      if (target.owner === 'media' && target.component === 'media_use' && owners.media) {
        return captureMediaUseEvidence(owners.media, target, actingSubject,
          () => owners.media!.canReadWork(principal, actingSubject, target.resource));
      }
      if (target.owner === 'source' && owners.source && ['synopsis', 'cover', 'record'].includes(target.component)) {
        const recordId = sourceId(target.resource);
        const observationId = target.revision ? sourceId(target.revision) : null;
        if (!recordId || !observationId) {
          throw new GovernanceInvalid('source evidence needs a record and observation');
        }
        const observation = await owners.source(principal, recordId, observationId);
        if (!observation) throw new GovernanceDenied('reporter cannot read the source observation');
        if (sourceId(observation.record) !== recordId) {
          throw new GovernanceInvalid('observation belongs to another source record');
        }
        return observation.retention === 'retained'
          ? result(target, 'available', observation.byteDigest, observation.mediaType, 'source-observation-v1')
          : result(target, 'unavailable', null, observation.mediaType, 'source-observation-v1');
      }
      return result(target, 'unsupported', null, null, 'no-admitted-exact-reader');
    },
  };
}

/** Current owner heads for staleness, including exact media Uses and Asset state. */
export function ownerTargetHeads(owners: { graph?: WorkActivationEnvironment; content?: Pool }): TargetHeads {
  return {
    async realmBasis(target) {
      if (target.owner !== 'graph') return null;
      if (!agent.test(target.resource)) throw new GovernanceInvalid('Graph target identity is invalid');
      if (!owners.graph) throw new GovernanceUnavailable('Graph target classification is unavailable');
      try {
        // Read every asserted type to detect competing primary owners.
        // Descriptions never introduce an owner or select a command profile.
        const rows = (await owners.graph.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT DISTINCT ?kind ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
            ${iri(target.resource)} a ?kind .
            OPTIONAL { FILTER(?kind = rv:Realm) ${iri(target.resource)} rv:head ?head }
          } } LIMIT 65`, 16_384)).results?.bindings ?? [];
        if (rows.length >= 65 || rows.some(row => row.kind?.type !== 'uri')) {
          throw new GovernanceUnavailable('Graph target kind or head is unavailable or ambiguous');
        }
        const primary = rows.filter(row => semanticResourceTypeRole(row.kind!.value) === 'PRIMARY');
        if (primary.length > 1) {
          throw new GovernanceUnavailable('Graph target kind or head is unavailable or ambiguous');
        }
        if (!primary.length) return null;
        const row = primary[0]!;
        if (row.kind!.value !== `${RV}Realm`) return null;
        if (row.head?.type !== 'uri' || !row.head.value) {
          throw new GovernanceUnavailable('Realm current head is unavailable');
        }
        const profile = await resolveRealmProfile(owners.graph, target.resource);
        return { ...profile, head: row.head.value };
      } catch (error) {
        if (error instanceof GovernanceUnavailable || error instanceof GovernanceInvalid) throw error;
        throw new GovernanceUnavailable(error instanceof Error ? error.message : 'Realm basis is unavailable');
      }
    },
    async current(target) {
      if (target.owner === 'graph' && owners.graph && agent.test(target.resource)) {
        const result = await owners.graph.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
            ${iri(target.resource)} ${target.component === 'structure' ? 'rv:structureHead' : 'rv:head'} ?head
          } } LIMIT 2`);
        const rows = result.results?.bindings ?? [];
        return rows.length === 1 ? rows[0]!.head!.value : null;
      }
      if (target.owner === 'content' && owners.content) {
        // Resolve the exact revision's variant, or an explicitly named variant.
        // A resource can have many variants; choosing its first would compare
        // a decision against an unrelated head.
        const row = (await owners.content.query<{ draft_head: string | null }>(`SELECT v.draft_head::text
          FROM content.variant v LEFT JOIN content.revision r ON r.variant_id = v.id AND r.id = $2::uuid
          WHERE v.resource_id = $1 AND ($2::uuid IS NOT NULL AND r.id IS NOT NULL
            OR $3::text IS NOT NULL AND v.id = $3::text) LIMIT 1`,
        [target.resource, target.revision && uuid.test(target.revision) ? target.revision : null,
          target.locator])).rows[0];
        return row?.draft_head ?? null;
      }
      if (target.owner === 'media' && owners.content && agent.test(target.resource)) {
        if (target.component === 'media_use') {
          if (!target.locator || !uuid.test(target.locator)) return null;
          const row = (await owners.content.query<{ head: string }>(`SELECT asset_revision_id::text AS head
            FROM media.use WHERE id = $1 AND target = $2`,
          [target.locator, target.resource])).rows[0];
          return row?.head ?? null;
        }
        const row = (await owners.content.query<{ head: string }>(`SELECT state_head::text AS head
          FROM media.asset WHERE id = $1`, [target.resource.slice('https://rezics.com/id/'.length)])).rows[0];
        return row?.head ?? null;
      }
      return null;
    },
  };
}
