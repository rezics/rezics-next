import type { Pool } from 'pg';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { resolveSubject } from '../library/subject-anchor.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readContext, publicContextEligibility } from '../semantic/context.ts';
import { currentRelationFacts, currentRelationKey } from '../semantic/current-relations.ts';
import { candidateSources } from '../semantic/fences.ts';
import { readRelease } from '../semantic/definitions.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { withPublicStatementReader } from '../semantic/statement-disclosure.ts';
import {
  classificationAssociationKey, classificationDigest,
  type ClassificationAssociation, type ClassificationUnavailableReason,
} from './source-classification-contract.ts';

export type ClassificationAssociationEvidence = Readonly<{
  stamp: string;
  source: { source: string; external_id: string; field_group: string } | null;
}>;
export type ClassificationAssociationResolution =
  | { state: 'available'; evidence: ClassificationAssociationEvidence }
  | { state: 'unavailable'; reason: ClassificationUnavailableReason };
/** Semantic retains ownership of candidate selection, disclosure, Context and provenance.
 * This adapter calls its published supplied-candidate resolver; it reads no Semantic tables directly.
 */
export function createClassificationAssociationReader(config: { pool: Pool; access: Access }) {
  return async (
    actor: Actor, associations: readonly ClassificationAssociation[], deadline: number,
  ): Promise<Map<string, ClassificationAssociationResolution>> => {
    const result = new Map<string, ClassificationAssociationResolution>();
    const context = { pool: config.pool, deadline };
    const subjects = new Map<string, boolean>();
    for (const id of new Set(associations.flatMap((a) => [a.subjectId, a.targetId]))) {
      const current = await resolveSubject(config, actor, id, undefined, context);
      subjects.set(id, current?.subjectId === id);
    }
    const contexts = new Map<string, Awaited<ReturnType<typeof readContext>>>();
    for (const id of new Set(associations.map((a) => a.contextId))) {
      const route = routeOf(id);
      if (route === null) { contexts.set(id, null); continue; }
      const resource = { route, id };
      const check = await accessCheck(config.access, actor, 'context:read', {
        ...resource, eligibility: publicContextEligibility(resource),
      }, context);
      contexts.set(id, await readContext(config.pool, id, check));
    }
    const releases = new Map<string, Awaited<ReturnType<typeof readRelease>>>();
    for (const release of new Set(associations.map((a) => a.release)))
      releases.set(release, await readRelease(config.pool, release));
    // Each group has one subject and Context. The published resolver's keys omit Context;
    // grouping prevents two Context views of a candidate from sharing a map entry.
    const groups = new Map<string, ClassificationAssociation[]>();
    for (const a of associations) {
      const key = classificationAssociationKey(a);
      result.set(key, { state: 'unavailable', reason: 'not_found' });
      if (!subjects.get(a.subjectId) || !subjects.get(a.targetId) || !contexts.get(a.contextId)) continue;
      const release = releases.get(a.release);
      if (!release) { result.set(key, { state: 'unavailable', reason: 'authority_unavailable' }); continue; }
      if (release.properties[a.property]?.relation?.group !== 'classification') continue;
      const groupKey = `${a.subjectId}\n${a.contextId}`;
      const group = groups.get(groupKey) ?? [];
      group.push(a); groups.set(groupKey, group);
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      const route = routeOf(first.subjectId)!;
      const defaults = contexts.get(first.contextId)!.context.defaults;
      const selected = group.map((a) => ({
        subject: a.subjectId, property: a.property, candidate: a.candidateId,
        target: a.targetId, context: a.contextId, defaults,
      }));
      const snapshot = await withPublicStatementReader(() => withReadTransaction(config.pool, async (client) => {
        await partitionReadClient(client, partitionOf(route));
        // Tuple fences are read later on independently released source homes.
        const facts = await currentRelationFacts(client, undefined, selected);
        const sources = await candidateSources(client, group.map((a) => ({
          route, subject_id: a.subjectId, candidate_id: a.candidateId,
        })));
        return { facts, sources };
      }, deadline));
      for (let index = 0; index < group.length; index++) {
        const a = group[index]!;
        const key = classificationAssociationKey(a);
        const fact = snapshot.facts.get(currentRelationKey(selected[index]!));
        if (!fact || fact.fact_revision !== a.revision || fact.fact_release !== a.release) continue;
        const body = fact.body as { value?: { type?: string; content?: unknown }; qualifiers?: unknown[] };
        if (body.value?.type !== 'value' || body.value.content !== a.targetId ||
          classificationDigest(body.qualifiers ?? []) !== a.qualifiersDigest) continue;
        const sourceKey = `${a.subjectId}\n${a.candidateId}`;
        if (!snapshot.sources.has(sourceKey)) {
          result.set(key, { state: 'unavailable', reason: 'provenance_unavailable' }); continue;
        }
        const source = snapshot.sources.get(sourceKey);
        if (source && !('field_group' in source)) {
          result.set(key, { state: 'unavailable', reason: 'provenance_unavailable' }); continue;
        }
        result.set(key, { state: 'available', evidence: {
          stamp: classificationDigest([a, fact, source, defaults]),
          source: source && 'field_group' in source ? source : null,
        } });
      }
    }
    return result;
  };
}
