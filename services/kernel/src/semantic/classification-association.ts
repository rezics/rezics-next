import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { accessCheck, type Access, type Actor, type Resource } from '../request/access.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { AccessUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { withReadTransaction } from './read.ts';
import { readCandidateDisclosure } from './disclosure.ts';
import { readItemIdentityVersion } from './item-identity.ts';
import { effectiveGlobalSlotFacts } from './slots.ts';
import { readRelease, GLOBAL_CONTEXT } from './definitions.ts';
import { subjectReadEligibility } from './eligibility.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import readVisibility from './read-visibility.sql';
import readAssociation from './classification-association-read.sql';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type CurrentClassificationAssociation = Readonly<{
  subjectId: string;
  subjectRoute: number;
  associationId: string;
  slotId: string;
  property: string;
  targetId: string;
  contextId: typeof GLOBAL_CONTEXT;
  release: string;
  revision: number;
  qualifiers: readonly unknown[];
  statementDigest: string;
  bindingHash: string;
}>;

type CurrentRead = {
  id: string;
  type: string;
  securityRevision: string;
  revision: number;
  transactionId: string;
    binding: Omit<CurrentClassificationAssociation, 'bindingHash'>;
};

/** Resolve one exact, currently selected Global classification statement. The returned digest binds
 * the original candidate, release, target and all qualifiers; it never follows redirects. */
export async function readCurrentClassificationAssociation(input: {
  pool: Pool;
  access: Access;
  actor: Actor;
  subjectId: string;
  associationId: string;
  action: string;
  deadline: number;
  time?: AuthoritativeTime;
}): Promise<CurrentClassificationAssociation | null> {
  const subjectRoute = routeOf(input.subjectId);
  if (
    subjectRoute === null ||
    routeOf(input.associationId) !== subjectRoute ||
    !uuid.test(input.subjectId) ||
    !uuid.test(input.associationId)
  )
    return null;
  requireAccessDeadline(input.deadline);

  const subject: Resource = {
    route: subjectRoute,
    id: input.subjectId,
    eligibility: subjectReadEligibility({ route: subjectRoute, id: input.subjectId }),
  };
  const ballotResource: Resource = {
    ...subject,
    eligibility: subjectReadEligibility({ route: subjectRoute, id: input.subjectId }, input.action),
  };
  const subjectRead = await accessCheck(input.access, input.actor, 'subject:read', subject, {
    pool: input.pool,
    deadline: input.deadline,
  });
  const ballotAction = await accessCheck(input.access, input.actor, input.action, ballotResource, {
    pool: input.pool,
    deadline: input.deadline,
  });

  const source = async (): Promise<CurrentRead | null> =>
    withReadTransaction(input.pool, async (client) => {
      requireAccessDeadline(input.deadline);
      const home = await readPartition(client, partitionOf(subjectRoute));
      if (!home || home.writeState === 'moved') throw new AccessUnavailableError('contention');
      const subjectAllowed = await subjectRead(client, input.time);
      const ballotAllowed = await ballotAction(client, input.time);
      if (!subjectAllowed || !ballotAllowed) {
        console.info('classification association access probe', input.action, subjectAllowed, ballotAllowed);
        return null;
      }

      const visible = await readVisibility.run(client, { route: subjectRoute, subject_id: input.subjectId });
      if (visible?.visibility !== 'visible' || !visible.type) return null;
      const subjectVersion = await readItemIdentityVersion(client, input.subjectId);
      if (!subjectVersion || subjectVersion.redirect !== null) return null;

      const candidate = await readAssociation.run(client, {
        route: subjectRoute,
        subject_id: input.subjectId,
        candidate_id: input.associationId,
      });
      if (!candidate || candidate.candidateId !== input.associationId || candidate.relation) return null;
      const revision = Number(candidate.revision);
      if (!Number.isSafeInteger(revision) || revision < 1 || typeof candidate.release !== 'string') return null;

      const release = await readRelease(client, candidate.release, { composed: false });
      if (!release) return null;
      const property = release.properties[candidate.property];
      const holder = release.types[visible.type];
      if (
        property?.relation?.group !== 'classification' ||
        property.datatype !== 'wikibase-item' ||
        !property.targets?.includes('skos:Concept') ||
        !holder?.properties.includes(candidate.property)
      )
        return null;

      const selected = await effectiveGlobalSlotFacts(client, input.subjectId, candidate.property, candidate.slotId);
      const current = selected.facts.find(
        (fact) =>
          fact.kind === 'statement' &&
          fact.statement_id === input.associationId &&
          fact.fact_release === candidate.release &&
          Number(fact.fact_revision) === revision,
      );
      if (!current) return null;
      const statement = candidate.statement as {
        property?: { id?: unknown };
        value?: { type?: unknown; content?: unknown };
        qualifiers?: unknown;
      };
      if (
        statement?.property?.id !== candidate.property ||
        statement.value?.type !== 'value' ||
        typeof statement.value.content !== 'string' ||
        routeOf(statement.value.content) === null ||
        !Array.isArray(statement.qualifiers)
      )
        return null;
      const canonicalStatement = canonicalize(candidate.statement);
      if (typeof canonicalStatement !== 'string') return null;
      const statementDigest = createHash('sha256').update(canonicalStatement).digest('hex');
      const targetId = statement.value.content;
      const disclosure = await readCandidateDisclosure(client, {
        subject: input.subjectId,
        candidate: input.associationId,
      });
      if (!disclosure?.disclosed) return null;

      return {
        id: input.subjectId,
        type: visible.type,
        securityRevision: visible.securityRevision,
        revision: subjectVersion.revision,
        transactionId: subjectVersion.transactionId,
        binding: {
          subjectId: input.subjectId,
          subjectRoute,
          associationId: input.associationId,
          slotId: candidate.slotId,
          property: candidate.property,
          targetId,
          contextId: GLOBAL_CONTEXT,
          release: candidate.release,
          revision,
          qualifiers: statement.qualifiers,
          statementDigest,
        },
      };
    }, input.deadline);

  const first = await source();
  if (!first) return null;
  const targetRoute = routeOf(first.binding.targetId)!;
  const target: Resource = {
    route: targetRoute,
    id: first.binding.targetId,
    eligibility: subjectReadEligibility({ route: targetRoute, id: first.binding.targetId }),
  };
  const targetRead = await accessCheck(input.access, input.actor, 'subject:read', target, {
    pool: input.pool,
    deadline: input.deadline,
  });
  const targetSnapshot = async () =>
    withReadTransaction(input.pool, async (client) => {
      requireAccessDeadline(input.deadline);
      const home = await readPartition(client, partitionOf(targetRoute));
      if (!home || home.writeState === 'moved') throw new AccessUnavailableError('contention');
      if (!(await targetRead(client, input.time))) return null;
      const visible = await readVisibility.run(client, { route: targetRoute, subject_id: first.binding.targetId });
      if (visible?.visibility !== 'visible' || visible.type !== 'skos:Concept') return null;
      const version = await readItemIdentityVersion(client, first.binding.targetId);
      if (!version || version.redirect !== null) return null;
      return { type: visible.type, securityRevision: visible.securityRevision, version };
    }, input.deadline);

  const firstTarget = await targetSnapshot();
  if (!firstTarget) return null;
  const last = await source();
  const lastTarget = await targetSnapshot();
  requireAccessDeadline(input.deadline);
  if (
    !last ||
    JSON.stringify(first) !== JSON.stringify(last) ||
    JSON.stringify(firstTarget) !== JSON.stringify(lastTarget)
  )
    throw new AccessUnavailableError('contention');

  const serialized = canonicalize(first.binding);
  if (typeof serialized !== 'string') throw new TypeError('Classification identity is not canonical JSON');
  return Object.freeze({
    ...first.binding,
    bindingHash: createHash('sha256').update(serialized).digest('hex'),
  });
}
