import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../../command/command.ts';
import { withConnection } from '../../database/pool.ts';
import { receiptKeysFor } from '../../command/receipt-key.ts';
import { ProblemError } from '../../http/problem-error.ts';
import { readPartition } from '../../partition/partition.ts';
import type { AccountActor } from '../../request/access.ts';
import { withRequestDeadline } from '../../request/deadline.ts';
import { newId, partitionOf } from '../../route/route.ts';
import { LibraryNotFoundError, requireRoute, sameAccountRoute, workStepDeadline } from '../collection-command-work.ts';
import type { Copy, CopyChanges } from '../entry-model.ts';
import * as store from '../entry-store.ts';
import { hasCopyStatus, resolveLibraryProfilePin } from '../profile.ts';
import { admitEntryAttempt } from '../entry-lifecycle.ts';
import { resolveSubject } from '../subject-anchor.ts';
import { decodeLibraryProfilePin } from '../profile-pin.ts';
import {
  createCopyOperationPlans,
  bindCopyCommandOperation,
  consumeCopyCommandAttempt,
  copyDetailReadStatementPlan,
  copyPrivateReadStatementPlan,
  copyRetentionReadStatementPlan,
  copyRetentionRestoreStatementPlan,
  executeCopyOperation,
} from '../copy-operation-bounds.ts';
import type { LibraryProfileSource } from '../profile-source.ts';
import { sameCopyProfileAnchor } from '../copy-model.ts';
import type { NativeCopyConfig, NativeCopyProducers, CopySourceObservation } from '../copy-model.ts';
export type { NativeCopyConfig, NativeCopyProducers } from '../copy-model.ts';
import { deadlineClient, within } from '../access-port.ts';
import type { CopyPresentation } from '../copy-model.ts';
import { prepareCopyPresentation } from '../copy-presentation.ts';
import { prepareCopyInventory, readCopyInventoryValues } from '../copy-inventory.ts';
import {
  copyConditionAdmission,
  decodeCopyConditionFacts,
  mergeCopyConditionFields,
  type CopyConditionPatch,
} from '../copy-condition.ts';
import type { CommandAttempt, CommandOutcome } from '../../command/command.ts';
import type { CopyApplicationPorts, CopyPatch, LibraryCursorCapability } from '../contract/index.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { CopyConflictError } from '../contract/index.ts';

type Command = { transactionId: string; time: AuthoritativeTime };
export type NativeCopyTypes = {
  transaction: CommandTransaction;
  time: AuthoritativeTime;
  attempt: CommandAttempt;
  command: Command;
  outcome: CommandOutcome<Copy>;
  copy: Copy;
  fact: NonNullable<Awaited<ReturnType<typeof store.readCopyFact>>>;
  source: LibraryProfileSource;
  observation: CopySourceObservation;
  retained: NonNullable<Awaited<ReturnType<ReturnType<typeof copyPrivateReadStatementPlan>['run']>>>;
  detail: {
    copy: Copy;
    compatibilityPin: ReturnType<typeof decodeLibraryProfilePin>;
    kindPin: ReturnType<typeof decodeLibraryProfilePin>;
    statusPin: ReturnType<typeof decodeLibraryProfilePin>;
  };
  presentation: CopyPresentation;
  inventory: Awaited<ReturnType<typeof prepareCopyInventory>>;
  inventoryValues: Awaited<ReturnType<typeof readCopyInventoryValues>>;
};

function conditionFields(input: CopyConditionPatch): CopyConditionPatch {
  const fields: {
    mediaCondition?: Exclude<CopyConditionPatch['mediaCondition'], undefined>;
    packagingCondition?: Exclude<CopyConditionPatch['packagingCondition'], undefined>;
  } = {};
  if (Object.hasOwn(input, 'mediaCondition') && input.mediaCondition !== undefined)
    fields.mediaCondition = input.mediaCondition;
  if (Object.hasOwn(input, 'packagingCondition') && input.packagingCondition !== undefined)
    fields.packagingCondition = input.packagingCondition;
  return fields;
}

function merged(current: Copy, patch: CopyPatch): CopyChanges {
  return {
    status: patch.status ?? current.status,
    location: patch.location === undefined ? current.location : patch.location,
    source: patch.source === undefined ? current.source : patch.source,
    acquiredOn: patch.acquiredOn === undefined ? current.acquiredOn : patch.acquiredOn,
    disposedOn: patch.disposedOn === undefined ? current.disposedOn : patch.disposedOn,
    note: patch.note === undefined ? current.note : patch.note,
    ...(current.conditionFacts === undefined ? {} : { conditionFacts: current.conditionFacts }),
  };
}

/** A missing row and another account's row are the same result, so a conflict cannot disclose either. */
async function lockOwned(
  tx: CommandTransaction,
  route: number,
  accountId: string,
  copyId: string,
  profileReadWork: NativeCopyProducers['work']['sessionProfileMigrationWork'],
): Promise<Copy> {
  await tx.query('SELECT copy_id FROM library.copy WHERE route = $1 AND copy_id = $2 AND account_id = $3 FOR UPDATE', [
    route,
    copyId,
    accountId,
  ]);
  const current = await store.readCopy(tx, route, copyId, profileReadWork);
  if (!current || current.accountId !== accountId) throw new LibraryNotFoundError();
  return current;
}

/** Copy loan creation locks the same copy row before inserting, so disposal and deletion serialize with lending. */
async function assertNoOpenLoan(
  tx: CommandTransaction,
  route: number,
  accountId: string,
  copyId: string,
): Promise<void> {
  const open = await tx.query(
    `SELECT loan_id FROM library.copy_loan
     WHERE route=$1 AND account_id=$2 AND copy_id=$3 AND returned_on IS NULL LIMIT 1`,
    [route, accountId, copyId],
  );
  if (open.rows.length) throw new CopyConflictError();
}

/** One adapter around the existing command runner, storage, immutable-release and source producers. */
export function createNativeCopyPorts(
  config: NativeCopyConfig,
  producers: NativeCopyProducers,
  cursors: LibraryCursorCapability<KeyRing>,
): CopyApplicationPorts<NativeCopyTypes> {
  const { pool, access, tokens, clock } = config;
  const plans = createCopyOperationPlans(producers.work);
  const runner = producers.commands;
  async function readOnly<T>(
    owner: AccountActor,
    body: (client: CommandTransaction) => Promise<T>,
    deadline?: number,
  ): Promise<T> {
    return withConnection(pool, async (client) => {
      const bounded = deadline === undefined ? client : deadlineClient(client, deadline);
      await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await producers.account.admit(bounded, owner);
        const result = await body(bounded);
        await bounded.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  function preparedCurrentSource(
    original: NativeCopyTypes['observation'],
    latest: NativeCopyTypes['observation'],
  ): LibraryProfileSource {
    if (original && !sameCopyProfileAnchor(original.anchor, latest?.anchor ?? null))
      throw new ProblemError('semantic_not_ready');
    if (!original && latest) throw new ProblemError('semantic_not_ready');
    if (!original || !latest) return null;
    if (
      original.source.kind !== latest.source.kind ||
      (original.source.kind === 'supported' &&
        latest.source.kind === 'supported' &&
        (original.source.pin.releaseDigest !== latest.source.pin.releaseDigest ||
          original.source.pin.profileId !== latest.source.pin.profileId ||
          original.source.pin.acceptingType !== latest.source.pin.acceptingType))
    )
      throw new ProblemError('semantic_not_ready');
    return latest.source;
  }

  async function observeDetail(
    owner: AccountActor,
    route: number,
    copyId: string,
    at: AuthoritativeTime,
    deadline: number,
  ) {
    const check = await producers.account.check(owner, route, at, deadline);
    return readOnly(
      owner,
      async (client) => {
        const bounded = deadlineClient(client, deadline);
        if (!(await check(bounded, at))) throw producers.account.denied();
        const partition = await readPartition(bounded, partitionOf(route));
        const row = await copyDetailReadStatementPlan({
          route,
          copy_id: copyId,
          account_id: owner.accountId,
        }).run(bounded);
        if (!partition || !row) throw new LibraryNotFoundError();
        const { libraryProfilePin, kindProfilePin, statusProfilePin, mediaCondition, packagingCondition, ...value } =
          row;
        const conditionFacts = decodeCopyConditionFacts(mediaCondition, packagingCondition);
        const copy: Copy = {
          ...value,
          createdAt: new Date(value.createdAt).toISOString(),
          updatedAt: new Date(value.updatedAt).toISOString(),
          ...(conditionFacts === undefined ? {} : { conditionFacts }),
        };
        return {
          fact: {
            copy,
            compatibilityPin: decodeLibraryProfilePin(libraryProfilePin),
            // The old mutable pin proves status only, never original kind.
            kindPin: decodeLibraryProfilePin(kindProfilePin),
            statusPin: decodeLibraryProfilePin(statusProfilePin ?? libraryProfilePin),
          },
          epoch: partition.epoch,
        };
      },
      deadline,
    );
  }

  return {
    deadline: workStepDeadline,
    remaining: (deadline) => Math.max(0, deadline - Date.now()),
    newId,
    requireRoute,
    sameAccountRoute,
    denied: producers.account.denied,
    notFound: () => new LibraryNotFoundError(),
    problem: (code) => new ProblemError(code),
    gate: (owner, deadline) =>
      withConnection(pool, (client) => producers.account.admit(deadlineClient(client, deadline), owner)),
    readOnly,
    within,
    request: withRequestDeadline,
    time: (deadline) => withConnection(pool, (client) => mintReadTime(deadlineClient(client, deadline), clock)),
    releaseTime: releaseOperationalTime,
    receiptKeys: () => receiptKeysFor(pool).keys.size,
    run(owner, spec, body) {
      return runner.ownAccountPrepared(
        owner,
        { ...spec, prepare: (attempt) => spec.prepare(attempt, attempt.time) },
        body,
      );
    },
    admitAttempt: (owner, action, attempt, deadline) => admitEntryAttempt(config, owner, action, attempt, deadline),
    plans,
    execute: executeCopyOperation,
    bind: bindCopyCommandOperation,
    consume: consumeCopyCommandAttempt,
    source: (owner, subjectId, at, deadline) =>
      producers.profileSource.observe({ pool, access, actor: owner, at, deadline }, subjectId),
    currentSource: preparedCurrentSource,
    read: (tx, route, copyId) => store.readCopy(tx, route, copyId, producers.work.sessionProfileMigrationWork),
    lock: (tx, route, accountId, copyId) =>
      lockOwned(tx, route, accountId, copyId, producers.work.sessionProfileMigrationWork),
    fact: store.readCopyFact,
    noOpenLoan: assertNoOpenLoan,
    async insert(tx, command, route, accountId, copyId, input, source) {
      if (source.kind !== 'supported' || !hasCopyStatus(source.profile, input.kind, input.status))
        throw new ProblemError('unsupported_library_profile');
      const requestedConditions = conditionFields(input);
      let conditionFacts;
      if (Object.keys(requestedConditions).length) {
        const acceptedKind = source.profile.copies?.kinds.find((candidate) => candidate.id === input.kind);
        if (!acceptedKind || copyConditionAdmission(acceptedKind).state !== 'supported')
          throw new ProblemError('unsupported_library_profile');
        conditionFacts = mergeCopyConditionFields({}, requestedConditions, { kind: acceptedKind, pin: source.pin });
      }
      const { mediaCondition: _mediaCondition, packagingCondition: _packagingCondition, ...copyInput } = input;
      const copy = await store.insertCopy(
        tx,
        route,
        {
          ...copyInput,
          status: input.status,
          subjectId: source.subjectId,
          id: copyId,
          accountId: accountId,
          ...(conditionFacts === undefined ? {} : { conditionFacts }),
        },
        { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
        { kind: input.kind, pin: source.pin },
      );
      return copy;
    },
    async update(tx, command, route, copyId, patch, fact, source) {
      const changes = merged(fact.copy, patch);
      if (
        source.kind !== 'supported' ||
        fact.kind === null ||
        !hasCopyStatus(source.profile, fact.kind, changes.status)
      )
        throw new ProblemError('unsupported_library_profile');
      const requestedConditions = conditionFields(patch);
      let conditionFacts = fact.copy.conditionFacts;
      if (Object.keys(requestedConditions).length) {
        const acceptedKind = source.profile.copies?.kinds.find((candidate) => candidate.id === fact.kind);
        if (!acceptedKind || copyConditionAdmission(acceptedKind).state !== 'supported')
          throw new ProblemError('unsupported_library_profile');
        conditionFacts = mergeCopyConditionFields(fact.copy.conditionFacts ?? {}, requestedConditions, {
          kind: acceptedKind,
          pin: source.pin,
        });
      }
      const nextChanges = {
        ...changes,
        ...(conditionFacts === undefined ? {} : { conditionFacts }),
      };
      const copy = await store.updateCopy(
        tx,
        route,
        copyId,
        patch.revision,
        nextChanges,
        {
          transactionId: command.transactionId,
          time: authoritativeTimeValue(command.time),
        },
        { kind: fact.kind, pin: source.pin, statusSupplied: Object.hasOwn(patch, 'status') },
      );
      return copy;
    },
    async delete(tx, command, route, copyId, revision) {
      return !!(await store.deleteCopy(tx, route, copyId, revision, {
        transactionId: command.transactionId,
        time: authoritativeTimeValue(command.time),
      }));
    },
    privateRead: (tx, route, accountId, copyId) =>
      copyPrivateReadStatementPlan({ route, copy_id: copyId, account_id: accountId })
        .run(tx)
        .then((row) => row ?? null),
    async validateRetained(owner, row, attempt, deadline) {
      const pin = decodeLibraryProfilePin(row.status_profile_pin ?? row.library_profile_pin);
      if (pin) {
        const release = await withConnection(pool, (client) =>
          producers.definitions.read(deadlineClient(client, deadline), pin.releaseDigest),
        );
        const profile = release ? resolveLibraryProfilePin({ digest: pin.releaseDigest, release }, pin) : null;
        if (!profile || row.kind === null || !hasCopyStatus(profile, row.kind, row.status))
          throw new Error('Retained copy accepted profile is unavailable');
      }
      const kindPin = decodeLibraryProfilePin(row.kind_profile_pin);
      if (kindPin) {
        const release = await withConnection(pool, (client) =>
          producers.definitions.read(deadlineClient(client, deadline), kindPin.releaseDigest, { composed: false }),
        );
        const profile = release ? resolveLibraryProfilePin({ digest: kindPin.releaseDigest, release }, kindPin) : null;
        if (!profile?.copies?.kinds.some((kind) => kind.id === row.kind))
          throw new Error('Retained copy accepted kind profile is unavailable');
      }
      const currentSubject = await resolveSubject(config, owner, row.subject_id, attempt.time, {
        pool,
        deadline,
        time: attempt.time,
        ...(attempt.commandWork ? { work: attempt.commandWork.access } : {}),
      });
      if (!currentSubject || currentSubject.subjectId !== row.subject_id) throw new LibraryNotFoundError();
    },
    retention: (tx, command, route, accountId, copyId) =>
      copyRetentionReadStatementPlan({
        route,
        copy_id: copyId,
        account_id: accountId,
        time: authoritativeTimeValue(command.time),
      })
        .run(tx)
        .then((row) => row ?? null),
    async restore(tx, command, route, accountId, input) {
      return !!(await copyRetentionRestoreStatementPlan({
        route,
        account_id: accountId,
        copy_id: input.copyId,
        deletion_id: input.deletionId,
        revision: input.revision,
        time: authoritativeTimeValue(command.time),
        transaction_id: command.transactionId,
      }).run(tx));
    },
    observeDetail,
    presentation: (owner, fact, at, deadline, languages) =>
      prepareCopyPresentation(
        { pool, access, actor: owner, at, deadline },
        fact,
        languages,
        producers.definitions,
        producers.profileSource,
      ),
    partition: (tx, route) => readPartition(tx, partitionOf(route)).then((partition) => partition ?? null),
    decodeCursor: (binding, cursor) => cursors.decode(tokens, binding, cursor),
    encodeCursor: (binding, cursor) => cursors.encode(tokens, binding, cursor),
    page: (tx, route, accountId, page, subjectId, kind, status) =>
      store.pageCopies(tx, route, accountId, page, subjectId, kind, status, producers.work.sessionProfileMigrationWork),
    inventoryValues: readCopyInventoryValues,
    inventory: (values, deadline, languages) =>
      prepareCopyInventory(pool, values, deadline, languages, producers.definitions),
  };
}
