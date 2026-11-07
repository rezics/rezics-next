import { jsonParameter } from '../database/json.ts';
import {
  beginSemanticRecordSourceSet,
  collectSemanticRecordFacts,
  sealSemanticRecordSourceSet,
} from './record-source-set.ts';
import { retainSubjectPageSource } from './subject-page-publication-store.ts';
import { disclosureAccount, keepStatementPrivate } from './statement-disclosure.ts';
import { checkStatementInput } from '@rezics/definitions/validate';
import type { Source } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { runCommand, type CommandTransaction } from '../command/command.ts';
import type { ProposalStatementOptions, ProposalWriteOptions } from './candidate-contract.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { redirectOf } from './subject-redirect.ts';
import { SubjectRedirectError, SubjectNotFoundError } from './contract/subject-errors.ts';
import { initializeRevisionAuthorship, revisionResource, StaleRevisionAuthorshipError } from './authorship.ts';
import { creationDeclares } from '../access/parent-creation.ts';
import { baseOf } from './definition-release-read.ts';
import { SUBJECT_REVISED } from './events.ts';
import {
  itemFacts,
  isRelationProperty,
  SubjectInputError,
  type Violation,
} from './item.ts';
import { rejectContent, rejectBulkContent } from './rules.ts';
import { authoredAuthorization, installAuthoredStatement } from './authored.ts';
import { accountSource, assertAgentStatementAccess, readItemDetails } from './subject.ts';
import { matchesTarget } from './targets.ts';
import insertCandidate from './candidates-insert-candidate.sql';
import insertProposalRevision from './candidates-insert-proposal-revision.sql';
import readSubjectRevision from './candidates-read-subject-revision.sql';
import updateSubjectRelease from './update-subject-release.sql';
import { declareCommandHistory } from '../history/application/index.ts';
import { asUniqueContention, PROPOSAL_UNIQUE_CONTENTION_CONSTRAINTS } from './candidate-command.ts';
import { expandSlot } from './slots.ts';
import { checkAuthoredValues } from './candidate-authored.ts';

const CANDIDATE_NS = '3c62c392-7c55-4fda-bf16-13b4853e7598';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
export async function proposeStatement(pool: Pool, options: ProposalStatementOptions) {
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
      const result = await writeProposal(tx, transactionId, { ...options, statement });
      await declareCommandHistory(tx, 'subject.propose', {
        response: { artifactType: 'command-receipt/v1', accounts: [] },
        events: result.events.map(() => ({ artifactType: 'outbox-event/v1', accounts: [] })),
      });
      return result;
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
  options: ProposalWriteOptions,
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
      statement: jsonParameter(factBody),
      release: options.release.digest,
      relation: isRelationProperty(options.release.release, input.property),
      revision,
    });
  } catch (error) {
    throw asUniqueContention(error, PROPOSAL_UNIQUE_CONTENTION_CONSTRAINTS);
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
