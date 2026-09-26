import type { Pool } from 'pg';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { GRAPHS, type WorkActivationEnvironment } from '../work/activate.ts';
import { readExactMainRevision, readExactWorkRevision, RevisionNotFound } from '../work/history.ts';
import { type CapturedEvidence, type EvidenceCapture, type EvidenceTarget, GovernanceDenied, GovernanceInvalid,
  sha256, type TargetHeads } from './store.ts';

const agent = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sourceId = (value: string): string | null => {
  const id = value.startsWith('https://rezics.com/id/') ? value.slice('https://rezics.com/id/'.length) : value;
  return uuid.test(id) ? id : null;
};

export interface EvidenceOwners {
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
}

const result = (target: EvidenceTarget, state: CapturedEvidence['state'], revisionDigest: string | null,
  representation: string | null, via: string): CapturedEvidence => ({ ...target, state, revisionDigest,
  representation, provenance: { capturedBy: via } });

/**
 * Captures exactly the named grain from its owner. A component without an
 * admitted exact reader is `unsupported`; no body is fabricated for
 * metadata-only objects and no current head replaces a named revision.
 */
export function ownerEvidenceCapture(owners: EvidenceOwners): EvidenceCapture {
  return {
    async capture(principal, actingSubject, target) {
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
      if (target.owner === 'graph' && owners.graph && (target.component === 'title' || target.component === 'name')) {
        if (!target.revision || !agent.test(target.revision) || !agent.test(target.resource)) {
          throw new GovernanceInvalid('graph evidence needs a Work and revision');
        }
        if (!await owners.graph.canReadWork(principal, actingSubject, target.resource)) {
          throw new GovernanceDenied('reporter cannot read the reported Work');
        }
        try {
          const exact = await readExactWorkRevision(owners.graph.env, target.revision, async work =>
            work === target.resource);
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

/** Current heads for staleness: graph `rv:head` of a Work/Main Version and a Content variant draft head. */
export function ownerTargetHeads(owners: { graph?: WorkActivationEnvironment; content?: Pool }): TargetHeads {
  return {
    async current(target) {
      if (target.owner === 'graph' && owners.graph && agent.test(target.resource)) {
        const result = await owners.graph.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?head WHERE { GRAPH <${GRAPHS.current}> { <${target.resource}> rv:head ?head } } LIMIT 2`);
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
      return null;
    },
  };
}
