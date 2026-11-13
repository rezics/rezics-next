import type { Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { newId, routeOf } from '../route/route.ts';
import type { DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { captureDurableInitiator, commandAccessContext, durableInitiatorCommitment } from './access-port.ts';
import { ContentNotFoundError, hostedPostAuthorization, type ContentCommandDependencies } from './commands.ts';
import { snapshot } from './reads.ts';
import {
  REVISION_DISCLOSURE_AUDIENCE,
  REVISION_DISCLOSURE_ISSUE,
  REVISION_DISCLOSURE_POLICY_VERSION,
  REVISION_DISCLOSURE_REVOKE,
  type RevisionDisclosureCommandContext,
  type RevisionDisclosureCommandValue,
  type RevisionDisclosureDependencies,
  type RevisionDisclosureIssueInput,
  type RevisionDisclosureRevokeInput,
  type RevisionDisclosureRow,
  type RevisionDisclosureSource,
} from './revision-disclosure-model.ts';
import {
  lookupIssuedRevisionDisclosure,
  lockRevisionDisclosureRow,
  observationOf,
  revisionDisclosureCatalogueHome,
  revisionDisclosureHex,
  revisionDisclosurePartition,
  revisionDisclosureRow,
  revisionDisclosureSourceHome,
  sameRevisionDisclosureRow,
  sameRevisionDisclosureSource,
  sourceOf,
} from './revision-disclosure-store.ts';
import { observeRevisionDisclosureSource, revisionDisclosureSourceCurrent } from './revision-disclosure-source.ts';
import { revisionDisclosureSourceDigest } from './revision-disclosure-initiator.ts';
import insertDisclosure from './revision-disclosure-insert.sql';
import revokeDisclosure from './revision-disclosure-revoke.sql';

type IssueState = Readonly<{
  source: RevisionDisclosureSource;
  capture: Pick<DurableInitiatorRecord, 'originalAccount' | 'originalDelegation'>;
  existing: RevisionDisclosureRow | null;
}>;

function account(actor: Actor) {
  if (actor.kind !== 'account') throw new ContentNotFoundError();
  return actor;
}

function uniqueIssuedConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === 'revision_disclosure_issued_key'
  );
}

function commandValue(
  row: RevisionDisclosureRow,
  reused: boolean,
  commitment?: string,
): RevisionDisclosureCommandValue {
  return {
    disclosureId: row.disclosure_id,
    state: row.revoked_at === null ? 'issued' : 'revoked',
    catalogueId: row.catalogue_id,
    reused,
    ...(commitment ? { durableInitiator: commitment } : {}),
  };
}

function issueEvent(row: RevisionDisclosureRow) {
  return {
    type: 'com.rezics.content.revision-disclosure.issued.v1',
    subject: row.disclosure_id,
    data: { disclosureId: row.disclosure_id, catalogueId: row.catalogue_id },
  };
}

function revokeEvent(row: RevisionDisclosureRow) {
  return {
    type: 'com.rezics.content.revision-disclosure.revoked.v1',
    subject: row.disclosure_id,
    data: { disclosureId: row.disclosure_id, catalogueId: row.catalogue_id },
  };
}

async function observeAuthorizedSource(
  deps: ContentCommandDependencies,
  target: RevisionDisclosureIssueInput['target'],
  context: RevisionDisclosureCommandContext,
): Promise<RevisionDisclosureSource> {
  const source = (
    await snapshot(deps, target.postId, context, (client) => observeRevisionDisclosureSource(client, target))
  ).value;
  if (!source) throw new ContentNotFoundError();
  return source;
}

function sourceAuthorization(
  deps: RevisionDisclosureDependencies,
  actor: Actor,
  source: RevisionDisclosureSource,
  context: RevisionDisclosureCommandContext,
  receipt: { kind: string; key: string; digest: Uint8Array },
): CommandAuthorization {
  return hostedPostAuthorization(deps, actor, source.threadId, source.postId, context, receipt);
}

/** Issue or reuse exact Book-scoped consent for one private opening revision. */
export async function issueRevisionDisclosure(
  deps: RevisionDisclosureDependencies,
  actor: Actor,
  input: RevisionDisclosureIssueInput,
  context: RevisionDisclosureCommandContext,
) {
  const issuer = account(actor);
  const selected = structuredClone(input);
  const route = revisionDisclosureSourceHome(selected.target);
  const catalogueRoute = revisionDisclosureCatalogueHome(selected.catalogueId);
  if (route === null || catalogueRoute === null) throw new ContentNotFoundError();
  const kind = REVISION_DISCLOSURE_ISSUE;
  const digest = requestDigest(kind, issuer, selected);
  const digestHex = revisionDisclosureHex(digest);
  const receipt = { kind, key: context.idempotencyKey, digest };
  const base = hostedPostAuthorization(
    deps,
    issuer,
    selected.target.threadId,
    selected.target.postId,
    context,
    receipt,
  );
  const prepared = new WeakMap<AuthoritativeTime, IssueState>();
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      const evidence = await base.prepare!(attempt);
      const accessContext = commandAccessContext({ pool: deps.pool, deadline: context.deadline }, attempt);
      const current = await observeAuthorizedSource(deps, selected.target, context);
      if (current.creatorAccountId !== issuer.accountId) throw new ContentNotFoundError();
      const existing = (
        await snapshot(deps, selected.target.postId, context, (client) =>
          lookupIssuedRevisionDisclosure(client, selected.catalogueId, selected.target),
        )
      ).value;
      if (existing && existing.issuer_account_id !== issuer.accountId) throw new ContentNotFoundError();
      const capture = await captureDurableInitiator(accessContext, issuer);
      prepared.set(attempt.time, { source: current, capture, existing });
      return evidence;
    },
    async authorize(tx, attempt, evidence) {
      const mode = await base.authorize(tx, attempt, evidence);
      const state = prepared.get(attempt.time);
      if (!state || !(await revisionDisclosureSourceCurrent(tx, state.source))) throw new ContentNotFoundError();
      return mode;
    },
    async finalize(tx, attempt, evidence) {
      const state = prepared.get(attempt.time);
      if (!state || !(await revisionDisclosureSourceCurrent(tx, state.source))) throw new ContentNotFoundError();
      await base.finalize?.(tx, attempt, evidence);
    },
  };
  return runCommand<RevisionDisclosureCommandValue>(
    deps.pool,
    {
      ...principalCommandIdentity(issuer),
      partition: revisionDisclosurePartition(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt,
      authorization,
    },
    async (tx, { transactionId, time }) => {
      const state = prepared.get(time);
      if (!state) throw new ContentNotFoundError();
      if (state.existing) {
        const current = await revisionDisclosureRow(tx, state.existing.disclosure_id);
        if (!current || !sameRevisionDisclosureRow(current, state.existing) || current.revoked_at !== null)
          throw new ContentNotFoundError();
        return noEffect(commandValue(current, true));
      }
      const disclosureId = newId(route);
      const operationId = newId(route);
      const recordSource = state.source;
      const sourceDigest = revisionDisclosureSourceDigest(
        {
          route,
          disclosure_id: disclosureId,
          catalogue_id: selected.catalogueId,
          issued_transaction_id: transactionId,
          licence: recordSource.licence,
          issuer_account_id: issuer.accountId,
          ...recordSource,
        },
        operationId,
      );
      const capture = state.capture;
      try {
        await insertDisclosure.run(tx, {
          route,
          disclosure_id: disclosureId,
          operation_id: operationId,
          thread_id: recordSource.threadId,
          post_id: recordSource.postId,
          revision_id: recordSource.revisionId,
          sha256: recordSource.sha256,
          licence: recordSource.licence,
          catalogue_id: selected.catalogueId,
          catalogue_route: catalogueRoute,
          source_post_transaction_id: recordSource.incarnation.postTransactionId,
          source_thread_transaction_id: recordSource.incarnation.threadTransactionId,
          source_post_security_revision: recordSource.incarnation.postSecurityRevision,
          source_thread_security_revision: recordSource.incarnation.threadSecurityRevision,
          issuer_account_id: issuer.accountId,
          issued_transaction_id: transactionId,
          issued_at: authoritativeTimeValue(time),
          audience_kind: REVISION_DISCLOSURE_AUDIENCE,
          policy_version: REVISION_DISCLOSURE_POLICY_VERSION,
          actor_client_id: issuer.clientId,
          actor_scopes: [...issuer.scopes],
          actor_requested_by: issuer.requestedBy,
          actor_authn_epoch: issuer.authnEpoch,
          original_minimum_authn_epoch: capture.originalAccount.minimumAuthnEpoch,
          original_operator_account_id: capture.originalAccount.operatorAccountId,
          original_delegation_transaction_id: capture.originalDelegation?.transactionId ?? null,
          original_delegation_issued_valid: capture.originalDelegation?.issuedValid ?? null,
          source_digest: sourceDigest,
          creation_idempotency_key: context.idempotencyKey,
          creation_request_digest: digestHex,
        });
      } catch (error) {
        if (!uniqueIssuedConflict(error)) throw error;
        const existing = await lookupIssuedRevisionDisclosure(tx, selected.catalogueId, selected.target);
        if (!existing || existing.issuer_account_id !== issuer.accountId) throw new ContentNotFoundError();
        return noEffect(commandValue(existing, true));
      }
      const row = await revisionDisclosureRow(tx, disclosureId);
      if (!row) throw new ContentNotFoundError();
      const record: DurableInitiatorRecord = {
        operation: { route, id: operationId, kind, sourceId: disclosureId },
        initiatorAccountId: issuer.accountId,
        actor: {
          kind: 'account',
          accountId: issuer.accountId,
          clientId: issuer.clientId,
          authnEpoch: issuer.authnEpoch,
          requestedBy: issuer.requestedBy,
          scopes: [...issuer.scopes],
        },
        recordedTransactionId: transactionId,
        sourceDigest,
        ...capture,
        creation: {
          commandKind: kind,
          idempotencyKey: context.idempotencyKey,
          requestDigest: digestHex,
          target: { route, id: recordSource.postId },
        },
      };
      return {
        value: commandValue(row, false, durableInitiatorCommitment(record)),
        events: [issueEvent(row)],
      };
    },
  );
}

/** Explicit revoke. Current source `post:revise` and container admission still apply. */
export async function revokeRevisionDisclosure(
  deps: RevisionDisclosureDependencies,
  actor: Actor,
  input: RevisionDisclosureRevokeInput,
  context: RevisionDisclosureCommandContext,
) {
  const revoker = account(actor);
  const selected = structuredClone(input);
  const route = routeOf(selected.disclosureId);
  if (route === null) throw new ContentNotFoundError();
  const initial = (
    await snapshot(deps, selected.disclosureId, context, (client) =>
      revisionDisclosureRow(client, selected.disclosureId),
    )
  ).value;
  if (!initial) throw new ContentNotFoundError();
  const source = sourceOf(initial);
  const kind = REVISION_DISCLOSURE_REVOKE;
  const digest = requestDigest(kind, revoker, selected);
  const receipt = { kind, key: context.idempotencyKey, digest };
  const base = sourceAuthorization(deps, revoker, source, context, receipt);
  const prepared = new WeakMap<AuthoritativeTime, RevisionDisclosureSource>();
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      const evidence = await base.prepare!(attempt);
      if (source.creatorAccountId !== revoker.accountId) throw new ContentNotFoundError();
      prepared.set(attempt.time, source);
      return evidence;
    },
    async authorize(tx, attempt, evidence) {
      const mode = await base.authorize(tx, attempt, evidence);
      const observed = prepared.get(attempt.time);
      if (!observed || !(await revisionDisclosureSourceCurrent(tx, observed))) throw new ContentNotFoundError();
      return mode;
    },
    async finalize(tx, attempt, evidence) {
      const observed = prepared.get(attempt.time);
      if (!observed || !(await revisionDisclosureSourceCurrent(tx, observed))) throw new ContentNotFoundError();
      await base.finalize?.(tx, attempt, evidence);
    },
  };
  return runCommand<RevisionDisclosureCommandValue>(
    deps.pool,
    {
      ...principalCommandIdentity(revoker),
      partition: revisionDisclosurePartition(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt,
      authorization,
    },
    async (tx, { transactionId, time }) => {
      const row = await lockRevisionDisclosureRow(tx, selected.disclosureId);
      if (!row || row.disclosure_id !== initial.disclosure_id || row.operation_id !== initial.operation_id)
        throw new ContentNotFoundError();
      if (row.revoked_at !== null) return noEffect(commandValue(row, true));
      if (
        row.issuer_account_id !== initial.issuer_account_id ||
        row.catalogue_id !== initial.catalogue_id ||
        !sameRevisionDisclosureSource(sourceOf(row), sourceOf(initial))
      )
        throw new ContentNotFoundError();
      await revokeDisclosure.run(tx, {
        route,
        disclosure_id: selected.disclosureId,
        revoked_at: authoritativeTimeValue(time),
        revocation_transaction_id: transactionId,
        revoker_account_id: revoker.accountId,
      });
      const current = await revisionDisclosureRow(tx, selected.disclosureId);
      if (!current || current.revoked_at === null) throw new ContentNotFoundError();
      return { value: commandValue(current, false), events: [revokeEvent(current)] };
    },
  );
}

export function revisionDisclosureObservationFromRow(row: RevisionDisclosureRow) {
  return observationOf(row);
}
