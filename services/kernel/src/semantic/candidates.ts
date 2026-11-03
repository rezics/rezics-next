import {
  beginSemanticRecordSourceSet,
  collectSemanticRecordFacts,
  sealSemanticRecordSourceSet,
} from './record-source-set.ts';
import { collectSemanticCandidateSource } from './record-source-set.ts';
import { retainSubjectPageSource } from './subject-page-publication-store.ts';
import { subjectPageSlot, recordSubjectPageDiff } from './subject-page-publication-native.ts';
import { disclosureAccount, keepStatementPrivate, statementAudience } from './statement-disclosure.ts';
import { withReadTransaction } from './read.ts';
import { readConsentTarget, type ConsentIdentity, type ConsentIdentityReader } from './candidate-consent-identity.ts';
import { checkStatementInput } from '@rezics/definitions/validate';
import type { Source, BatchReference } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { currentCommand, runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { fencedIds } from './fences.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { redirectOf, SubjectRedirectError } from './merges.ts';
import { initializeRevisionAuthorship, revisionResource, StaleRevisionAuthorshipError } from './authorship.ts';
import { creationDeclares } from '../access/index.ts';
import { activeRelease, GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { baseOf, layeredRelease } from './extensions.ts';
import { termContext } from '@rezics/definitions/extension';
import { LINK_KEYS_CHANGED, LINKS_CHANGED } from './events.ts';
import { SUBJECT_REVISED } from './events.ts';
import { recordPrivacyReduction } from './public-filter-source.ts';
import {
  factDataTypes,
  itemFacts,
  isRelationProperty,
  resolveItem,
  SubjectInputError,
  type Statement,
  type Violation,
} from './item.ts';
import { holderFacts } from './link-keys.ts';
import { contextLinkChanges, linkChanges } from './link-changes.ts';
import { PageCursorError } from './page.ts';
import { rejectBulkContent, rejectContent } from './rules.ts';
import { authoredAuthorization, installAuthoredStatement, type ProposalInstall } from './authored.ts';
import {
  candidateFact,
  currentAcceptance,
  expandSlot,
  insertAcceptance,
  insertAdoption,
  latestAdoption,
  resolveSlot,
  slotId,
  slotView,
  type Adoption,
  type Candidate,
} from './slots.ts';
import {
  accountSource,
  assertAgentStatementAccess,
  readItemDetails,
  readLabels,
  type AgentSelfSource,
} from './subject.ts';
import { contextSnapshot } from './context.ts';
import registerRelationContext from './relation-context-register.sql';
import listRelationContexts from './relation-context-list.sql';
import { matchesTarget } from './targets.ts';
import changeCurrentFacts from './change-current-facts.sql';
import insertCandidate from './candidates-insert-candidate.sql';
import insertEditorialRevision from './candidates-insert-editorial-revision.sql';
import insertProposalRevision from './candidates-insert-proposal-revision.sql';
import readAdoptionSubject from './candidates-read-adoption-subject.sql';
import readCandidatePage from './candidates-read-candidate-page.sql';
import readCandidateLifecycle from './candidates-read-lifecycle.sql';
import readCompactCandidate from './candidates-read-compact-candidate.sql';
import readDecisionCandidate from './candidates-read-decision-candidate.sql';
import readHidden from './candidates-read-hidden.sql';
import readHiddenIds from './candidates-read-hidden-ids.sql';
import readProvenance from './candidates-read-provenance.sql';
import readRevisions from './candidates-read-revisions.sql';
import readSlotCandidate from './candidates-read-slot-candidate.sql';
import readSubjectRevision from './candidates-read-subject-revision.sql';
import readCandidateVisibility from './candidates-read-visibility.sql';
import readCandidateOwners from './candidates-read-owners.sql';
import updateSubjectRelease from './update-subject-release.sql';

export class SubjectNotFoundError extends Error {}
export class EditorialConflictError extends Error {}
const CANDIDATE_NS = '3c62c392-7c55-4fda-bf16-13b4853e7598';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `.run` is one row, a row list, or null. Callers keep the same row and row-count checks. */
function listed<T>(result: T[] | T | null): T[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

function validatedStatement(
  subject: string,
  type: string,
  release: { digest: string; release: Release },
  raw: unknown,
  allowContent = false,
  authoredDocuments = true,
) {
  const property = record(raw) && record(raw.property) && typeof raw.property.id === 'string' ? raw.property.id : '';
  const definition = Object.hasOwn(release.release.types, type) ? release.release.types[type] : undefined;
  const subjectErrors: Violation[] = !definition
    ? [{ pointer: '/type', code: 'unsupported' }]
    : !definition.properties.includes(property)
      ? [{ pointer: '/statement/property/id', code: 'unsupported' }]
      : [];
  const checked = checkStatementInput(
    raw,
    subjectErrors.length ? undefined : release.release,
    allowContent ? {} : { rejectContent: authoredDocuments ? rejectContent : rejectBulkContent, authoredDocuments },
  );
  const violations = [...subjectErrors, ...checked.violations];
  if (violations.length) throw new SubjectInputError(violations);
  const input = { type, labels: { en: 'Validation' }, statements: { [property]: [raw] } };
  const facts = itemFacts(subject, input, type, release.release);
  return { property, fact: facts.find((fact) => fact.kind === 'statement')!, items: checked.targets };
}

/** Only authored values are checked before the receipt; other proposal errors retain receipt ordering. */
function checkAuthoredValues(statement: unknown, release: Release) {
  const snaks: [unknown, string][] = [[statement, '/statement']];
  if (record(statement)) {
    if (Array.isArray(statement.qualifiers))
      statement.qualifiers.forEach((snak, i) => snaks.push([snak, `/statement/qualifiers/${i}`]));
    if (Array.isArray(statement.references))
      statement.references.forEach((reference, i) => {
        if (record(reference) && Array.isArray(reference.parts))
          reference.parts.forEach((snak, j) => snaks.push([snak, `/statement/references/${i}/parts/${j}`]));
      });
  }
  const paths = snaks.flatMap(([snak, path]) =>
    record(snak) &&
    record(snak.property) &&
    typeof snak.property.id === 'string' &&
    release.properties[snak.property.id]?.datatype === 'document'
      ? [`${path}/value/content`]
      : [],
  );
  if (!paths.length) return;
  const checked = checkStatementInput(statement, release, { rejectContent, authoredDocuments: true });
  const errors = checked.violations.filter((error) =>
    paths.some((path) => error.pointer === path || error.pointer.startsWith(`${path}/`)),
  );
  if (errors.length) throw new SubjectInputError(errors);
}

export async function proposeStatement(
  pool: Pool,
  options: {
    subject: string;
    statement: unknown;
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    release: { digest: string; release: Release };
    authorization: CommandAuthorization;
    deadline: number;
    clock?: () => Date;
    routeKey?: Uint8Array;
    /** Server declaration only; allocation remains inside the native body. */
    expectedRevision?: number;
  },
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  const statement = structuredClone(options.statement);
  checkAuthoredValues(statement, options.release.release);
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: 'subject.propose',
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: authoredAuthorization(options.authorization, { route, id: options.subject }),
      clock: options.clock,
    },
    async (tx, { transactionId }) => {
      return writeProposal(tx, transactionId, { ...options, statement });
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

/** Allocate and validate a proposal inside its subject's command transaction. */
export async function writeProposal(
  tx: CommandTransaction,
  transactionId: string,
  options: Pick<Parameters<typeof proposeStatement>[1], 'subject' | 'statement' | 'release'> & {
    expectedRevision?: number;
    source?: Source | AgentSelfSource;
    routeKey?: Uint8Array;
    /** Sourced bulk summary and cover store content's reference instead of rejecting the datatype. */
    allowContent?: boolean;
    /** Runs after the candidate id and revision are allocated and before the candidate row is inserted. */
    install?: ProposalInstall;
  },
) {
  const sourceSet = await beginSemanticRecordSourceSet(tx);
  const route = routeOf(options.subject)!;
  const subject = listed(await readSubjectRevision.run(tx, { route, subject_id: options.subject }))[0];
  if (!subject) throw new SubjectNotFoundError();
  if (options.expectedRevision !== undefined && subject.revision + 1 !== options.expectedRevision)
    throw new StaleRevisionAuthorshipError();
  const redirect = await redirectOf(tx, options.subject);
  if (redirect) throw new SubjectRedirectError(options.subject, redirect);
  const input = validatedStatement(
    options.subject,
    subject.type,
    options.release,
    options.statement,
    options.allowContent === true,
    options.source === undefined,
  );
  const details = await readItemDetails(tx, [options.subject, ...input.items.map((item) => item.id)]);
  const privateAccount = await disclosureAccount(tx, options.release.release, input.property, input.fact.body);
  assertAgentStatementAccess(
    tx,
    [
      options.subject,
      ...input.items
        .filter(
          (item) =>
            !(
              options.release.release.properties[input.property]?.disclosure === 'sourceOrConsent' &&
              item.pointer === '/statement/value/content'
            ),
        )
        .map((item) => item.id),
    ],
    details,
  );
  const errors = input.items.flatMap((item) =>
    matchesTarget(options.release.release, details.get(item.id)?.type ?? '', item.targets)
      ? []
      : [{ pointer: item.pointer, code: 'out_of_range' as const }],
  );
  if (errors.length) throw new SubjectInputError(errors);
  const revision = subject.revision + 1;
  const candidate = derivedId(CANDIDATE_NS, `${options.subject}\n${revision}`, route);
  const body = structuredClone(input.fact.body);
  const replacement = options.install ? await options.install({ candidate, revision, body }) : undefined;
  let factBody =
    replacement === undefined
      ? body
      : {
          ...(body as Record<string, unknown>),
          value: {
            ...(body as { value: Record<string, unknown> }).value,
            content: replacement,
          },
        };
  const authoredEvents: { type: string; subject: string; data: unknown }[] = [];
  if (!options.allowContent && options.source === undefined) {
    const installed = await installAuthoredStatement(
      tx,
      options.subject,
      options.release.release,
      { candidate, revision, body: factBody },
      input.property,
    );
    factBody = installed.body;
    authoredEvents.push(...installed.events);
  }
  try {
    await expandSlot(
      tx,
      options.subject,
      input.property,
      transactionId,
      input.fact.slot_id,
      isRelationProperty(options.release.release, input.property),
    );
    await insertProposalRevision.run(tx, {
      route,
      subject_id: options.subject,
      revision,
      release: baseOf(options.release.digest),
      transaction_id: transactionId,
      source: options.source ?? accountSource(tx, [options.subject, ...input.items.map((item) => item.id)]),
    });
    if (options.source === undefined && creationDeclares(tx, revisionResource(options.subject, revision)))
      await initializeRevisionAuthorship(tx, { subject: options.subject, revision });
    await updateSubjectRelease.run(tx, {
      route,
      subject_id: options.subject,
      release: baseOf(options.release.digest),
    });
    await insertCandidate.run(tx, {
      route,
      subject_id: options.subject,
      candidate_id: candidate,
      slot_id: input.fact.slot_id,
      property: input.property,
      rank: (input.fact.body as { rank: string }).rank,
      statement: factBody,
      release: options.release.digest,
      relation: isRelationProperty(options.release.release, input.property),
      revision,
    });
  } catch (error) {
    // PostgreSQL can report a concurrent insert as a uniqueness failure before SSI detects the race.
    if (
      record(error) &&
      error.code === '23505' &&
      ['revision_pkey', 'candidate_pkey', 'fact_pkey'].includes(String(error.constraint))
    ) {
      error.code = '40001';
    }
    throw error;
  }
  await collectSemanticRecordFacts(
    tx,
    options.subject,
    [{ ...input.fact, statement_id: candidate, body: factBody }],
    revision,
  );
  if (options.source && 'source' in options.source && options.routeKey)
    await retainSubjectPageSource(tx, {
      subject: { route, id: options.subject },
      candidates: [candidate],
      source: options.source,
      routeKey: options.routeKey,
    });
  if (privateAccount)
    await keepStatementPrivate(tx, {
      subject: options.subject,
      candidate,
      slot: input.fact.slot_id,
      property: input.property,
      body: factBody,
      account: privateAccount,
      revision,
      release: options.release.release,
    });
  await sealSemanticRecordSourceSet(tx, sourceSet);
  return {
    value: { candidate, revision },
    events: [
      {
        type: SUBJECT_REVISED,
        subject: options.subject,
        data: { id: options.subject, revision, kind: 'propose' },
      },
      { type: 'com.rezics.statement.proposed.v1', subject: options.subject, data: { candidate, revision } },
      ...authoredEvents,
    ],
  };
}

type EditorialWriteOptions = {
  subject: string;
  actor: AccountActor;
  idempotencyKey: string;
  digest: Uint8Array;
  authorization: CommandAuthorization;
  deadline: number;
  clock?: () => Date;
  routeKey?: Uint8Array;
};

async function appendEditorialRevision(
  tx: Parameters<Parameters<typeof runCommand>[2]>[0],
  input: {
    subject: string;
    route: number;
    revision: number;
    release: string;
    kind: 'accept' | 'reject' | 'adopt';
    transactionId: string;
  },
): Promise<void> {
  await insertEditorialRevision.run(tx, {
    route: input.route,
    subject_id: input.subject,
    revision: input.revision,
    kind: input.kind,
    release: baseOf(input.release),
    transaction_id: input.transactionId,
  });
  await updateSubjectRelease.run(tx, {
    route: input.route,
    subject_id: input.subject,
    release: baseOf(input.release),
  });
}

function retryEditorialUniqueness(error: unknown): void {
  if (
    record(error) &&
    error.code === '23505' &&
    ['revision_pkey', 'acceptance_pkey', 'adoption_pkey'].includes(String(error.constraint))
  )
    error.code = '40001';
}

export async function decideCandidate(
  pool: Pool,
  options: EditorialWriteOptions & {
    candidate: string;
    context: string;
    decision: 'accept' | 'reject';
    expectedHead: number | null;
  },
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  const defaults =
    options.context === GLOBAL_CONTEXT ? {} : ((await contextSnapshot(pool, options.context))?.defaults ?? {});
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: 'subject.decide',
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
      clock: options.clock,
    },
    async (tx, { transactionId }) => {
      const sourceSet = await beginSemanticRecordSourceSet(tx);
      type CandidateRow = {
        revision: number;
        release: string;
        candidate_id: string;
        property: string;
        slot_id: string;
        relation: boolean;
      };
      const found = listed(
        await readDecisionCandidate.run(tx, {
          route,
          subject_id: options.subject,
          candidate_id: options.candidate,
        }),
      );
      let candidate: CandidateRow | undefined = found[0];
      if (!candidate) {
        candidate = listed(
          await readCompactCandidate.run(tx, {
            route,
            subject_id: options.subject,
            candidate_id: options.candidate,
          }),
        )[0] as CandidateRow | undefined;
      }
      if (!candidate) throw new SubjectNotFoundError();
      await collectSemanticCandidateSource(tx, options.subject, options.candidate);
      const concealed = await readHidden.run(tx, {
        route,
        subject_id: options.subject,
        candidate_id: options.candidate,
      });
      if (listed(concealed).length > 0) throw new SubjectNotFoundError();
      if (await redirectOf(tx, options.subject)) throw new EditorialConflictError();
      // A Context's relation type is unknown elsewhere until Global adopts it.
      if (termContext(candidate.property) !== null) {
        const active = await activeRelease(tx);
        const visible = active && (await layeredRelease(tx, active, options.context)).release;
        if (!visible?.properties[candidate.property])
          throw new SubjectInputError([{ pointer: '/candidate', code: 'unsupported' }]);
      }

      const publicationRelease = await readRelease(tx, candidate.release);
      if (!publicationRelease) throw new Error('Candidate release is missing');
      const publicationBefore =
        options.context === GLOBAL_CONTEXT
          ? await subjectPageSlot(
              tx,
              options.subject,
              candidate.property,
              candidate.slot_id,
              publicationRelease,
              options.routeKey,
            )
          : null;
      const release = candidate.relation ? publicationRelease : null;
      const before = release
        ? (await slotView(tx, options.subject, candidate.property, options.context, defaults, candidate.slot_id)).facts
        : [];
      const global = release
        ? (await slotView(tx, options.subject, candidate.property, GLOBAL_CONTEXT, {}, candidate.slot_id)).facts
        : [];
      if (release && options.context !== GLOBAL_CONTEXT)
        await registerRelationContext.run(tx, {
          route,
          subject_id: options.subject,
          slot_id: candidate.slot_id,
          context_id: options.context,
        });
      await expandSlot(tx, options.subject, candidate.property, transactionId, candidate.slot_id, candidate.relation);
      if (options.decision === 'reject') {
        const adoption = await latestAdoption(
          tx,
          options.subject,
          candidate.property,
          options.context,
          candidate.slot_id,
        );
        if (adoption?.mode === 'replace' && adoption.selection.some((entry) => entry.candidate === options.candidate))
          throw new EditorialConflictError();
      }

      const revision = candidate.revision + 1;
      try {
        await appendEditorialRevision(tx, {
          subject: options.subject,
          route,
          revision,
          release: candidate.release,
          kind: options.decision,
          transactionId,
        });
        const head = await insertAcceptance(
          tx,
          options.subject,
          options.candidate,
          options.context,
          options.expectedHead,
          options.decision,
          revision,
          candidate.slot_id,
        );
        const linkEvents: { type: string; subject: string; data: unknown }[] = [];
        if (publicationBefore)
          await recordSubjectPageDiff(
            tx,
            options.subject,
            transactionId,
            publicationBefore,
            await subjectPageSlot(
              tx,
              options.subject,
              candidate.property,
              candidate.slot_id,
              publicationRelease,
              options.routeKey,
            ),
            linkEvents,
          );
        if (release) {
          const subject = await readAdoptionSubject.run(tx, { route, subject_id: options.subject });
          if (!subject) throw new SubjectNotFoundError();
          const after = (
            await slotView(tx, options.subject, candidate.property, options.context, defaults, candidate.slot_id)
          ).facts;
          const identity = await holderFacts(tx, options.subject, release);
          const metadata = { subject: options.subject, release, type: identity.type, identityFacts: identity.facts };
          const dataTypes = factDataTypes(release, [...global, ...before, ...after]);
          const changes =
            options.context === GLOBAL_CONTEXT
              ? linkChanges(before, after, dataTypes, metadata)
              : contextLinkChanges(global, before, after, dataTypes, metadata, options.context);
          if (changes.length)
            linkEvents.push({
              type: LINKS_CHANGED,
              subject: options.subject,
              data: {
                subject: options.subject,
                revision,
                security_revision: Number(subject.security_revision),
                changes,
              },
            });
        }
        await sealSemanticRecordSourceSet(tx, sourceSet);
        return {
          value: {
            acceptance: {
              context: options.context,
              candidate: options.candidate,
              decision: options.decision,
              head,
            },
            revision,
          },
          events: [
            ...linkEvents,
            {
              type: SUBJECT_REVISED,
              subject: options.subject,
              data: { id: options.subject, revision, kind: options.decision },
            },
            {
              type:
                options.decision === 'accept' ? 'com.rezics.statement.accepted.v1' : 'com.rezics.statement.rejected.v1',
              subject: options.subject,
              data: { candidate: options.candidate, context: options.context, revision, head },
            },
          ],
        };
      } catch (error) {
        retryEditorialUniqueness(error);
        throw error;
      }
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

export async function adoptCandidates(
  pool: Pool,
  options: EditorialWriteOptions & {
    context: string;
    property: string;
    slot?: string;
    mode: Adoption['mode'];
    selection: { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[];
    expectedHead: number | null;
    release: { digest: string; release: Release };
  },
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  const defaults =
    options.context === GLOBAL_CONTEXT ? {} : ((await contextSnapshot(pool, options.context))?.defaults ?? {});
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: 'subject.adopt',
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
      clock: options.clock,
    },
    async (tx, { transactionId }) => {
      const sourceSet = await beginSemanticRecordSourceSet(tx);
      const subject = listed(await readAdoptionSubject.run(tx, { route, subject_id: options.subject }))[0];
      if (!subject) throw new SubjectNotFoundError();
      if (await redirectOf(tx, options.subject)) throw new EditorialConflictError();
      const type = options.release.release.types[subject.type];

      if (options.context === GLOBAL_CONTEXT && options.mode !== 'replace')
        throw new SubjectInputError([{ pointer: '/mode', code: 'unsupported' }]);
      if ((options.mode === 'inherit' || options.mode === 'suppress') && options.selection.length)
        throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);
      const definition = options.release.release.properties[options.property];
      if (!type || !type.properties.includes(options.property) || !definition)
        throw new SubjectInputError([{ pointer: '/property', code: 'unsupported' }]);
      const slot = options.slot ?? slotId(options.subject, options.property);

      if (options.selection.length > 32) throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);
      const hiddenCandidates = new Set<string>();
      const hiddenIds = [
        ...new Set(options.selection.map((entry) => entry.candidate).filter((id) => routeOf(id) === route)),
      ];
      if (hiddenIds.length) {
        const concealed = await readHiddenIds.run(tx, {
          route,
          subject_id: options.subject,
          candidate_ids: hiddenIds,
          viewer_account: '00000000-0000-0000-0000-000000000000',
          viewer_moderator: false,
        });
        for (const row of listed(concealed)) hiddenCandidates.add(row.candidate_id);
      }
      const state = await resolveSlot(tx, options.subject, options.property, options.context, slot);
      const compact = new Set(state.compact.map((candidate) => candidate.candidate_id));
      for (const [index, entry] of options.selection.entries()) {
        let supported = compact.has(entry.candidate);
        if (!supported) {
          const result = await readSlotCandidate.run(tx, {
            route,
            subject_id: options.subject,
            slot_id: slot,
            candidate_id: entry.candidate,
          });
          supported = listed(result).length > 0;
        }
        if (routeOf(entry.candidate) !== route || !supported || hiddenCandidates.has(entry.candidate))
          throw new SubjectInputError([{ pointer: `/selection/${index}/candidate`, code: 'unsupported' }]);
      }
      for (const entry of options.selection) await collectSemanticCandidateSource(tx, options.subject, entry.candidate);
      const seen = new Set<string>();
      for (const [index, entry] of options.selection.entries()) {
        if (seen.has(entry.candidate))
          throw new SubjectInputError([{ pointer: `/selection/${index}/candidate`, code: 'invalid_format' }]);
        seen.add(entry.candidate);
      }
      const deprecated = options.selection.findIndex((entry) => entry.rank === 'deprecated');
      if (deprecated >= 0)
        throw new SubjectInputError([{ pointer: `/selection/${deprecated}/rank`, code: 'unsupported' }]);
      if (!definition.multivalued && options.selection.length > 1)
        throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);

      const publicationBefore =
        options.context === GLOBAL_CONTEXT
          ? await subjectPageSlot(
              tx,
              options.subject,
              options.property,
              slot,
              options.release.release,
              options.routeKey,
            )
          : null;
      const beforeFacts = (await slotView(tx, options.subject, options.property, options.context, defaults, slot))
        .facts;
      const globalFacts =
        options.context === GLOBAL_CONTEXT
          ? beforeFacts
          : (await slotView(tx, options.subject, options.property, GLOBAL_CONTEXT, {}, slot)).facts;
      const identity = await holderFacts(tx, options.subject, options.release.release);
      const contextViews = new Map<string, typeof beforeFacts>();
      if (isRelationProperty(options.release.release, options.property)) {
        if (options.context !== GLOBAL_CONTEXT)
          await registerRelationContext.run(tx, {
            route,
            subject_id: options.subject,
            slot_id: slot,
            context_id: options.context,
          });
        else
          for (const row of await listRelationContexts.run(tx, { route, subject_id: options.subject, slot_id: slot }))
            contextViews.set(
              row.context_id,
              (await slotView(tx, options.subject, options.property, row.context_id, {}, slot)).facts,
            );
      }
      let oldGlobalCount = 0;
      if (options.context === GLOBAL_CONTEXT) {
        const global = await resolveSlot(tx, options.subject, options.property, GLOBAL_CONTEXT, slot);
        oldGlobalCount = global.expanded
          ? global.adoption?.mode === 'replace'
            ? global.adoption.selection.length
            : 0
          : global.compact.length;
      }
      await expandSlot(
        tx,
        options.subject,
        options.property,
        transactionId,
        slot,
        isRelationProperty(options.release.release, options.property),
      );
      const revision = subject.revision + 1;
      const selection = options.selection as Adoption['selection'];
      if (options.context === GLOBAL_CONTEXT && !isRelationProperty(options.release.release, options.property)) {
        const newGlobalCount = options.mode === 'replace' ? selection.length : 0;
        const updated = await changeCurrentFacts.run(tx, {
          route,
          subject_id: options.subject,
          delta: newGlobalCount - oldGlobalCount,
        });
        if (updated.length === 0) throw new EditorialConflictError();
      }
      try {
        await appendEditorialRevision(tx, {
          subject: options.subject,
          route,
          revision,
          release: options.release.digest,
          kind: 'adopt',
          transactionId,
        });
        const head = await insertAdoption(
          tx,
          options.subject,
          options.property,
          options.context,
          options.expectedHead,
          options.mode,
          selection,
          revision,
          slot,
        );
        if (options.context === GLOBAL_CONTEXT) {
          const previous = state.expanded
            ? state.adoption?.mode === 'replace'
              ? state.adoption.selection
              : []
            : state.compact.map((candidate) => ({ candidate: candidate.candidate_id, rank: candidate.rank }));
          const nextRanks = new Map(options.selection.map(({ candidate, rank }) => [candidate, rank]));
          const removed = previous.filter((entry) => nextRanks.get(entry.candidate) !== entry.rank);
          if (removed.length)
            await recordPrivacyReduction(tx, {
              partition: partitionOf(route),
              transactionId,
              time: currentCommand(tx).time,
              cause: 'selection',
              affected: removed.map((entry) => ({
                kind: 'selection' as const,
                route,
                subject: options.subject,
                slot,
                candidate: entry.candidate,
              })),
              impacts: [
                {
                  kind: 'keys',
                  route,
                  subject: options.subject,
                  keys: [{ kind: 'property', property: options.property }],
                },
              ],
            });
        }
        for (const entry of selection) {
          const local = await currentAcceptance(tx, options.subject, entry.candidate, options.context);
          const effective =
            local ??
            (options.context === GLOBAL_CONTEXT
              ? null
              : await currentAcceptance(tx, options.subject, entry.candidate, GLOBAL_CONTEXT));
          if (effective?.verdict !== 'accept') throw new EditorialConflictError();
        }
        const events: { type: string; subject: string; data: unknown }[] = [
          {
            type: SUBJECT_REVISED,
            subject: options.subject,
            data: { id: options.subject, revision, kind: 'adopt' },
          },
        ];
        if (publicationBefore)
          await recordSubjectPageDiff(
            tx,
            options.subject,
            transactionId,
            publicationBefore,
            await subjectPageSlot(
              tx,
              options.subject,
              options.property,
              slot,
              options.release.release,
              options.routeKey,
            ),
            events,
          );
        if (beforeFacts) {
          const afterFacts = (await slotView(tx, options.subject, options.property, options.context, defaults, slot))
            .facts;
          const metadata = {
            subject: options.subject,
            release: options.release.release,
            type: subject.type,
            ...(identity?.facts === undefined ? {} : { identityFacts: identity.facts }),
          };
          const dataTypes = factDataTypes(options.release.release, [...globalFacts, ...beforeFacts, ...afterFacts]);
          const changes =
            options.context === GLOBAL_CONTEXT
              ? linkChanges(beforeFacts, afterFacts, dataTypes, metadata)
              : contextLinkChanges(globalFacts, beforeFacts, afterFacts, dataTypes, metadata, options.context);
          for (const [context, before] of contextViews) {
            const after = (await slotView(tx, options.subject, options.property, context, {}, slot)).facts;
            changes.push(
              ...contextLinkChanges(
                globalFacts,
                before,
                after,
                factDataTypes(options.release.release, [...globalFacts, ...afterFacts, ...before, ...after]),
                metadata,
                context,
                afterFacts,
              ),
            );
          }
          if (changes.length > 0) {
            events.push({
              type: LINKS_CHANGED,
              subject: options.subject,
              data: {
                subject: options.subject,
                revision,
                security_revision: Number(subject.security_revision),
                changes,
              },
            });
          }
          if (options.context === GLOBAL_CONTEXT && options.property === 'schema:datePublished') {
            for (const direction of ['holder', 'target'] as const)
              events.push({
                type: LINK_KEYS_CHANGED,
                subject: options.subject,
                data: {
                  subject: options.subject,
                  direction,
                  revision,
                  security_revision: Number(subject.security_revision),
                  cursor: [],
                },
              });
          }
        }
        await sealSemanticRecordSourceSet(tx, sourceSet);
        return {
          value: {
            adoption: {
              context: options.context,
              property: options.property,
              mode: options.mode,
              selection,
              head,
            },
            revision,
          },
          events,
        };
      } catch (error) {
        retryEditorialUniqueness(error);
        throw error;
      }
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

type PageOptions = {
  subject: string;
  limit: number;
  cursor?: string;
  authorize: (client: PoolClient) => Promise<boolean>;
};
async function page<T>(
  pool: Pool,
  ring: KeyRing,
  options: PageOptions,
  binding: CursorBinding,
  validAfter: (after: CursorKey[]) => boolean,
  read: (client: PoolClient, after: CursorKey[] | null) => Promise<{ value: T; after: CursorKey[] | null }>,
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  let cursor: { epoch: number; after: CursorKey[] } | null = null;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, options.cursor);
    if (!decoded.ok) throw new PageCursorError(decoded.reason);
    if (!validAfter(decoded.after)) throw new PageCursorError('invalid');
    cursor = decoded;
  }
  return withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    const subject = listed(await readCandidateVisibility.run(client, { route, subject_id: options.subject }))[0];
    if (!partition || subject?.visibility !== 'visible' || !(await options.authorize(client)))
      throw new SubjectNotFoundError();
    if (cursor && cursor.epoch !== partition.epoch) throw new PageCursorError('stale');
    const result = await read(client, cursor?.after ?? null);
    return {
      ...result.value,
      next: result.after ? encodeCursor(ring, binding, { epoch: partition.epoch, after: result.after }) : null,
      component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
    };
  });
}

export function listRevisions(pool: Pool, ring: KeyRing, options: PageOptions) {
  return page(
    pool,
    ring,
    options,
    { operation: 'subject.list_revisions', parameters: { subject: options.subject } },
    (after) => after.length === 1 && Number.isSafeInteger(after[0]) && Number(after[0]) >= 1,
    async (client, after) => {
      const result = listed(
        await readRevisions.run(client, {
          route: routeOf(options.subject)!,
          subject_id: options.subject,
          before: Number(after?.[0] ?? 2147483647),
          page_limit: options.limit + 1,
        }),
      ) as { revision: number; kind: string; release: string; source: Source | null }[];
      const revisions = result.slice(0, options.limit);
      return { value: { revisions }, after: result.length > options.limit ? [revisions.at(-1)!.revision] : null };
    },
  );
}

async function candidatePage(pool: Pool, ring: KeyRing, options: CandidatePageOptions) {
  const contextRecord = options.context === GLOBAL_CONTEXT ? null : await contextSnapshot(pool, options.context);
  if (options.context !== GLOBAL_CONTEXT && !contextRecord) throw new SubjectNotFoundError();
  const defaults = contextRecord?.defaults ?? {};
  return page(
    pool,
    ring,
    options,
    {
      operation: 'subject.list_candidates',
      parameters: {
        subject: options.subject,
        property: options.property,
        slot: options.slot ?? slotId(options.subject, options.property),
        context: options.context,
      },
    },
    (after) =>
      after.length === 3 &&
      Number.isSafeInteger(after[0]) &&
      Number(after[0]) >= 1 &&
      Number.isInteger(after[1]) &&
      Number(after[1]) >= 0 &&
      Number(after[1]) <= 32 &&
      typeof after[2] === 'string' &&
      routeOf(after[2]) === routeOf(options.subject),
    async (client, after) => {
      const identityAdmitted =
        options.identity?.actor.kind === 'account' &&
        (await readPartition(client, partitionOf(routeOf(options.subject)!)))?.writeState === 'active';
      const slot = options.slot ?? slotId(options.subject, options.property);
      const state = await resolveSlot(client, options.subject, options.property, options.context, slot);
      type Decided = Candidate & { verdict: 'accept' | 'reject' | 'abstain' | null; head: number | null };
      let rows: Decided[];
      if (state.expanded) {
        rows = listed(
          await readCandidatePage.run(client, {
            route: routeOf(options.subject)!,
            subject_id: options.subject,
            slot_id: slot,
            context_id: options.context,
            after_revision: Number(after?.[0] ?? 0),
            after_view_order: Number(after?.[1] ?? 0),
            after_candidate_id: String(after?.[2] ?? '00000000-0000-0000-0000-000000000000'),
            page_limit: options.limit + 1,
          }),
        );
      } else {
        rows = state.compact
          .filter(
            (row) =>
              !after ||
              row.revision > Number(after[0]) ||
              (row.revision === after[0] && row.view_order > Number(after[1])),
          )
          .sort((a, b) => a.revision - b.revision || a.view_order - b.view_order)
          .slice(0, options.limit + 1)
          .map((row) => ({
            ...row,
            verdict: options.context === GLOBAL_CONTEXT ? 'accept' : null,
            head: options.context === GLOBAL_CONTEXT ? 1 : null,
          }));
      }
      const window = rows.slice(0, options.limit);
      const lifecycleRows = window.length
        ? listed(
            await readCandidateLifecycle.run(client, {
              route: routeOf(options.subject)!,
              subject_id: options.subject,
              candidate_ids: window.map((row) => row.candidate_id),
            }),
          )
        : [];
      const lifecycle = new Map(lifecycleRows.map((row) => [row.candidate_id, row.state]));
      const hidden = new Set<string>();
      if (window.length) {
        const owners = listed(
          await readCandidateOwners.run(client, {
            route: routeOf(options.subject)!,
            subject_id: options.subject,
            candidate_ids: window.map((row) => row.candidate_id),
          }),
        ) as {
          candidate_id: string;
          principal_kind: 'account' | 'anonymous' | 'erased';
          principal_id: string;
          account_state: string | null;
          account_fenced: boolean | null;
        }[];
        const located = new Set(owners.map((owner) => owner.candidate_id));
        for (const row of window) if (!located.has(row.candidate_id)) hidden.add(row.candidate_id);
        for (const owner of owners) {
          if (
            owner.principal_kind === 'account' &&
            (owner.account_state !== 'active' || owner.account_fenced !== false)
          )
            hidden.add(owner.candidate_id);
        }
        const concealed = await readHiddenIds.run(client, {
          route: routeOf(options.subject)!,
          subject_id: options.subject,
          candidate_ids: window.map((row) => row.candidate_id),
          ...(await statementAudience(client)),
        });
        for (const row of listed(concealed)) hidden.add(row.candidate_id);
      }
      // Hidden rows leave this page short. next stays set until the candidate sequence ends.
      const shown = window.filter((row) => !hidden.has(row.candidate_id));
      const releases = new Map<string, Release>();
      for (const row of shown.filter(
        (row) => !['deleted', 'purging', 'purged'].includes(lifecycle.get(row.candidate_id) ?? 'active'),
      )) {
        if (releases.has(row.release)) continue;
        const release = await readRelease(client, row.release);
        if (!release) throw new Error('Candidate release is missing');
        releases.set(row.release, release);
      }
      const view = await slotView(client, options.subject, options.property, options.context, defaults, slot);
      const ranks = new Map(
        view.facts.map((fact) => [
          fact.statement_id!,
          (fact.body as { rank?: 'normal' | 'preferred' | 'deprecated' }).rank ?? null,
        ]),
      );
      let subjectIdentity: ConsentIdentity['subject'] | undefined;
      let candidates: (
        | { id: string; deleted: true }
        | {
            consentIdentity?: ConsentIdentity;
            source: Source | null;
            retracted: number | null;
            retraction: { source: Source; references: BatchReference[] } | null;
            id: string;
            statement: Statement;
            release: string;
            revision: number;
            decision: 'accepted' | 'rejected' | 'abstained' | null;
            head: number | null;
            rank: 'normal' | 'preferred' | 'deprecated' | null;
          }
      )[] = [];
      for (const row of shown) {
        const provenance = listed(
          await readProvenance.run(client, {
            route: routeOf(options.subject)!,
            subject_id: options.subject,
            revision: row.revision,
            candidate_id: row.candidate_id,
          }),
        )[0] as
          | {
              source: Source | null;
              retracted: number | null;
              retraction: { source: Source; references: BatchReference[] } | null;
            }
          | undefined;
        if (['deleted', 'purging', 'purged'].includes(lifecycle.get(row.candidate_id) ?? 'active')) {
          if (options.routeKey && provenance?.source) {
            const fenced = await fencedIds(client, options.routeKey, [
              { id: row.candidate_id, source: provenance.source },
            ]);
            if (fenced.has(row.candidate_id)) continue;
          }
          candidates.push({ id: row.candidate_id, deleted: true });
          continue;
        }
        const fact = candidateFact(options.property, row);
        const dataTypes = factDataTypes(releases.get(row.release)!, [fact]);
        const statement = resolveItem(options.subject, [fact], '', dataTypes, {
          revision: row.revision,
          release: row.release,
          context: options.context,
        }).statements[options.property]![0]!;
        let identity: ConsentIdentity | undefined;
        if (
          identityAdmitted &&
          provenance?.retracted === null &&
          releases.get(row.release)?.properties[options.property]?.disclosure === 'sourceOrConsent' &&
          statement.property.data_type === 'wikibase-item' &&
          statement.value.type === 'value' &&
          typeof statement.value.content === 'string'
        ) {
          subjectIdentity ??= {
            id: options.subject,
            labels: (await readLabels(client, [options.subject])).get(options.subject) ?? {},
          };
          identity = { subject: subjectIdentity, target: null };
        }
        candidates.push({
          ...provenance!,
          ...(identity ? { consentIdentity: identity } : {}),
          id: row.candidate_id,
          statement,
          release: row.release,
          revision: row.revision,
          decision:
            row.verdict === 'accept'
              ? 'accepted'
              : row.verdict === 'reject'
                ? 'rejected'
                : row.verdict === 'abstain'
                  ? 'abstained'
                  : null,
          head: row.head,
          rank: ranks.get(row.candidate_id) ?? null,
        });
      }
      if (options.routeKey && candidates.length) {
        const gone = await fencedIds(
          client,
          options.routeKey,
          candidates.flatMap((row) => ('deleted' in row ? [] : [{ id: row.id, source: row.source }])),
        );
        candidates = candidates.filter((row) => 'deleted' in row || !gone.has(row.id));
      }
      const last = window.at(-1);
      return {
        value: {
          candidates,
          adoption: state.adoption ? { mode: state.adoption.mode, head: state.adoption.head } : null,
        },
        after: rows.length > options.limit && last ? [last.revision, last.view_order, last.candidate_id] : null,
      };
    },
  );
}

type CandidatePageOptions = PageOptions & {
  property: string;
  context: string;
  slot?: string;
  routeKey?: Uint8Array;
  identity?: ConsentIdentityReader & {
    prepareSource: () => Promise<PageOptions['authorize']>;
    refreshAudience: () => Promise<void>;
  };
};

/** Stage only the page's admitted main item targets, then re-read source admission,
 * audience, disclosure, candidate lifecycle and tuple fences before disclosing labels.
 */
export async function listCandidates(pool: Pool, ring: KeyRing, options: CandidatePageOptions) {
  const first = await candidatePage(pool, ring, options);
  if (
    !options.identity ||
    !first.candidates.some((candidate) => 'consentIdentity' in candidate && candidate.consentIdentity)
  )
    return first;
  const targets = new Map<string, ConsentIdentity['target']>();
  for (const candidate of first.candidates) {
    if ('deleted' in candidate || !candidate.consentIdentity) continue;
    if (candidate.statement.value.type !== 'value' || typeof candidate.statement.value.content !== 'string') continue;
    const target = candidate.statement.value.content;
    if (!targets.has(target)) targets.set(target, await readConsentTarget(pool, options.identity, target));
  }
  await options.identity.refreshAudience();
  const authorize = await options.identity.prepareSource();
  const current = await candidatePage(pool, ring, { ...options, authorize });
  for (const candidate of current.candidates) {
    if ('deleted' in candidate || !candidate.consentIdentity) continue;
    const prior = first.candidates.find((row) => row.id === candidate.id);
    if (
      !prior ||
      'deleted' in prior ||
      prior.release !== candidate.release ||
      JSON.stringify(prior.statement) !== JSON.stringify(candidate.statement)
    ) {
      delete candidate.consentIdentity;
      continue;
    }
    candidate.consentIdentity.target =
      candidate.statement.value.type === 'value' && typeof candidate.statement.value.content === 'string'
        ? (targets.get(candidate.statement.value.content) ?? null)
        : null;
  }
  return current;
}
