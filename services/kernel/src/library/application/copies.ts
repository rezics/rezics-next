/** Complete Copy use cases. Native time, command attempts and funded effects arrive through ports. */
import { CopyConflictError, CopyInvalidError, COPY_DEFAULT_LIMIT, COPY_MAX_LIMIT } from '../contract/index.ts';
import type {
  LibraryActor,
  LibraryAccountActor,
  CopyApplication,
  CopyApplicationPorts,
  CopyNativeTypes,
  CopyPageOptions,
  CopyCursorBinding,
} from '../contract/index.ts';
import {
  parseCreate,
  parseUpdate,
  parseCopyRestore,
  copySubjectId,
  copyVocabularyValue,
  copyRevisionValue,
  routeOf,
} from '../core/index.ts';

const UPDATED_EVENT = 'com.rezics.library.copy.updated.v1';
const DELETED_EVENT = 'com.rezics.library.copy.deleted.v1';
function event(type: string, accountId: string, copyId: string) {
  return { type, subject: accountId, data: { copyId } };
}

export function createCopyApplication<N extends CopyNativeTypes>(ports: CopyApplicationPorts<N>): CopyApplication<N> {
  type PreparedSource = { observation: N['observation'] } | { error: unknown };
  function requireActor(actor: LibraryActor, action: string): LibraryAccountActor {
    if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action))
      throw ports.denied();
    return actor;
  }
  async function gate(actor: LibraryActor, action: string, deadline: number) {
    const owner = requireActor(actor, action);
    const route = ports.requireRoute(owner.accountId);
    await ports.execute(ports.plans.gate(route, owner.accountId), () => ports.gate(owner, deadline));
    return owner;
  }

  async function prepareSource(
    owner: LibraryAccountActor,
    subjectId: string,
    at: N['time'],
    deadline: number,
  ): Promise<PreparedSource> {
    try {
      return {
        observation: await ports.source(owner, subjectId, at, deadline),
      };
    } catch (error) {
      // Preparation cannot invalidate an authorized exact receipt.
      return { error };
    }
  }

  function preparedCurrentSource(before: PreparedSource, after: PreparedSource): N['source'] {
    if ('error' in before) throw before.error;
    if ('error' in after) throw after.error;
    return ports.currentSource(before.observation, after.observation);
  }

  async function createCopy(actor: LibraryActor, input: unknown, requestKey: string) {
    const deadline = ports.deadline();
    const owner = await gate(actor, 'copy:create', deadline);
    const parsed = parseCreate(input);
    const route = ports.requireRoute(owner.accountId);
    const copyId = ports.newId(route);
    const plan = ports.plans.mutation('create', {
      route,
      accountId: owner.accountId,
      subjectId: parsed.subjectId,
      requestKey,
      receiptKeys: ports.receiptKeys(),
      clientId: owner.clientId,
      requestedBy: owner.requestedBy,
      durationMs: ports.remaining(deadline),
      commandInput: parsed,
      copyId,
      kind: parsed.kind,
      status: parsed.status,
      location: parsed.location,
      source: parsed.source,
      acquiredOn: parsed.acquiredOn,
      disposedOn: parsed.disposedOn,
      note: parsed.note,
      mediaCondition: parsed.mediaCondition,
      packagingCondition: parsed.packagingCondition,
    });
    return ports.run(
      owner,
      {
        action: 'copy:create',
        kind: 'library.copy.create',
        requestKey,
        input: parsed,
        deadline,
        execution: (dispatch) => ports.bind(plan, dispatch),
        async prepare(attempt, at) {
          await ports.consume(plan);
          await ports.admitAttempt(owner, 'copy:create', attempt, deadline);
          const original = await prepareSource(owner, parsed.subjectId, at, deadline);
          const current = await prepareSource(owner, parsed.subjectId, at, deadline);
          return { original, current };
        },
      },
      async (tx, command, prepared) => {
        if (parsed.kind === undefined) throw new CopyInvalidError('kind');
        if (parsed.status === undefined) throw new CopyInvalidError('status');
        const source = preparedCurrentSource(prepared.original, prepared.current);
        if (!source) throw ports.notFound();
        const copy = await ports.insert(
          tx,
          command,
          route,
          owner.accountId,
          copyId,
          { ...parsed, kind: parsed.kind, status: parsed.status },
          source,
        );
        return { value: copy, events: [event(UPDATED_EVENT, owner.accountId, copy.id)] };
      },
    );
  }

  async function updateCopy(actor: LibraryActor, copyId: string, input: unknown, requestKey: string) {
    const deadline = ports.deadline();
    const owner = await gate(actor, 'copy:update', deadline);
    const patch = parseUpdate(input);
    const route = ports.sameAccountRoute(owner.accountId, copyId);
    const commandInput = { copyId, ...patch };
    const plan = ports.plans.mutation('update', {
      route,
      accountId: owner.accountId,
      copyId,
      requestKey,
      receiptKeys: ports.receiptKeys(),
      clientId: owner.clientId,
      requestedBy: owner.requestedBy,
      durationMs: ports.remaining(deadline),
      commandInput,
      revision: patch.revision,
      status: patch.status,
      location: patch.location,
      source: patch.source,
      acquiredOn: patch.acquiredOn,
      disposedOn: patch.disposedOn,
      note: patch.note,
      mediaCondition: patch.mediaCondition,
      packagingCondition: patch.packagingCondition,
    });
    return ports.run(
      owner,
      {
        action: 'copy:update',
        kind: 'library.copy.update',
        requestKey,
        input: commandInput,
        deadline,
        execution: (dispatch) => ports.bind(plan, dispatch),
        async prepare(attempt, at) {
          await ports.consume(plan);
          await ports.admitAttempt(owner, 'copy:update', attempt, deadline);
          // Release the owner's read checkout before visiting source and Global anchors.
          const current = await ports.readOnly(owner, (client) => ports.read(client, route, copyId), deadline);
          if (current?.accountId !== owner.accountId) return { subjectId: null, original: null, current: null };
          const original = await prepareSource(owner, current.subjectId, at, deadline);
          const latest = await prepareSource(owner, current.subjectId, at, deadline);
          return { subjectId: current.subjectId, original, current: latest };
        },
      },
      async (tx, command, prepared) => {
        const current = await ports.lock(tx, route, owner.accountId, copyId);
        if (current.revision !== patch.revision) throw new CopyConflictError();
        const fact = await ports.fact(tx, route, copyId);
        if (!fact || fact.copy.accountId !== owner.accountId) throw ports.notFound();
        const changes = {
          disposedOn: patch.disposedOn === undefined ? fact.copy.disposedOn : patch.disposedOn,
          status: patch.status ?? fact.copy.status,
        };
        if (changes.disposedOn !== null || changes.status === 'disposed')
          await ports.noOpenLoan(tx, route, owner.accountId, copyId);
        if (prepared.subjectId !== fact.copy.subjectId || !prepared.original || !prepared.current)
          throw new CopyConflictError();
        const source = preparedCurrentSource(prepared.original, prepared.current);
        if (!source || source.subjectId !== fact.copy.subjectId) throw ports.notFound();
        const copy = await ports.update(tx, command, route, copyId, patch, fact, source);
        if (!copy) throw new CopyConflictError();
        return { value: copy, events: [event(UPDATED_EVENT, owner.accountId, copy.id)] };
      },
    );
  }

  async function deleteCopy(actor: LibraryActor, copyId: string, revision: number | undefined, requestKey: string) {
    const deadline = ports.deadline();
    const owner = await gate(actor, 'copy:delete', deadline);
    const expected = revision === undefined ? undefined : copyRevisionValue(revision);
    const route = ports.sameAccountRoute(owner.accountId, copyId);
    const commandInput = { copyId, ...(expected === undefined ? {} : { revision: expected }) };
    const plan = ports.plans.mutation('delete', {
      route,
      accountId: owner.accountId,
      copyId,
      requestKey,
      receiptKeys: ports.receiptKeys(),
      clientId: owner.clientId,
      requestedBy: owner.requestedBy,
      durationMs: ports.remaining(deadline),
      commandInput,
      revision: expected,
    });
    return ports.run(
      owner,
      {
        action: 'copy:delete',
        kind: 'library.copy.delete',
        requestKey,
        input: commandInput,
        deadline,
        execution: (dispatch) => ports.bind(plan, dispatch),
        async prepare(attempt, at) {
          await ports.consume(plan);
          await ports.admitAttempt(owner, 'copy:delete', attempt, deadline);
        },
      },
      async (tx, command) => {
        const current = await ports.lock(tx, route, owner.accountId, copyId);
        if (expected === undefined || current.revision !== expected || expected > 2_147_483_644)
          throw new CopyConflictError();
        await ports.noOpenLoan(tx, route, owner.accountId, copyId);
        const deletion = await ports.delete(tx, command, route, copyId, expected);
        if (!deletion) throw new CopyConflictError();
        // Preserve the existing native result/replay. HTTP returns no payload; its metadata
        // is the receipt transaction id and this exact original revision plus one.
        return { value: current, events: [event(DELETED_EVENT, owner.accountId, copyId)] };
      },
    );
  }

  async function restoreCopy(actor: LibraryActor, copyId: string, input: unknown, requestKey: string) {
    const deadline = ports.deadline();
    const owner = await gate(actor, 'copy:update', deadline);
    const selected = parseCopyRestore(copyId, input);
    const route = ports.sameAccountRoute(owner.accountId, copyId);
    const plan = ports.plans.mutation('restore', {
      route,
      accountId: owner.accountId,
      copyId,
      requestKey,
      receiptKeys: ports.receiptKeys(),
      clientId: owner.clientId,
      requestedBy: owner.requestedBy,
      durationMs: ports.remaining(deadline),
      commandInput: selected,
      revision: selected.revision,
      deletionId: selected.deletionId,
    });
    return ports.run(
      owner,
      {
        action: 'copy:update',
        kind: 'library.copy.restore',
        requestKey,
        input: selected,
        deadline,
        execution: (dispatch) => ports.bind(plan, dispatch),
        async prepare(attempt, at) {
          await ports.consume(plan);
          await ports.admitAttempt(owner, 'copy:update', attempt, deadline);
          try {
            // This exact read owns no checkout while immutable release and original/terminal
            // disclosure adapters visit their own anchors. Errors are deferred until receipt miss.
            const row = await ports.readOnly(
              owner,
              async (client) => {
                return ports.privateRead(client, route, owner.accountId, copyId);
              },
              deadline,
            );
            if (!row) throw ports.notFound();
            await ports.validateRetained(owner, row, attempt, deadline);
            return { error: null };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        const row = await ports.retention(tx, command, route, owner.accountId, copyId);
        if (!row) throw ports.notFound();
        if (row.deletionId === null) throw ports.problem('copy_restore_occupied');
        if (row.deletionId !== selected.deletionId || row.revision !== selected.revision)
          throw ports.problem('copy_restore_stale');
        if (row.expired) throw ports.problem('copy_restore_expired');
        if (prepared.error) throw prepared.error;
        const restored = await ports.restore(tx, command, route, owner.accountId, selected);
        if (!restored) throw ports.problem('copy_restore_stale');
        const copy = await ports.read(tx, route, copyId);
        if (!copy) throw new Error('Restored copy is missing');
        return { value: copy, events: [event(UPDATED_EVENT, owner.accountId, copyId)] };
      },
    );
  }

  async function readCopy(actor: LibraryActor, copyId: string): Promise<N['copy']> {
    const owner = requireActor(actor, 'copy:read');
    const route = ports.sameAccountRoute(owner.accountId, copyId);
    const deadline = ports.deadline();
    return ports.execute(ports.plans.read(route, owner.accountId, copyId), () =>
      ports.readOnly(
        owner,
        async (client) => {
          const copy = await ports.read(client, route, copyId);
          if (!copy || copy.accountId !== owner.accountId) throw ports.notFound();
          return copy;
        },
        deadline,
      ),
    );
  }

  function readPresentedCopy(
    actor: LibraryActor,
    copyId: string,
    languages?: readonly string[],
  ): Promise<N['copy'] & { presentation: N['presentation'] }>;
  function readPresentedCopy<T>(
    actor: LibraryActor,
    copyId: string,
    languages: readonly string[],
    render: (copy: N['copy'], presentation: N['presentation'], disclosure: { subject: boolean }) => Promise<T>,
  ): Promise<T>;
  /** Render between released observations so summaries cannot escape the final owner/source fence. */
  async function readPresentedCopy<T>(
    actor: LibraryActor,
    copyId: string,
    languages: readonly string[] = [],
    render?: (copy: N['copy'], presentation: N['presentation'], disclosure: { subject: boolean }) => Promise<T>,
  ): Promise<T | (N['copy'] & { presentation: N['presentation'] })> {
    const owner = requireActor(actor, 'copy:read');
    const route = ports.sameAccountRoute(owner.accountId, copyId);
    const deadline = ports.deadline();
    return ports.execute(ports.plans.presentation(route, owner.accountId, copyId, copyId), () =>
      ports.request(deadline, () =>
        ports.within(deadline, async () => {
          const time = () => ports.time(deadline);
          const observed = (at: N['time']) => ports.observeDetail(owner, route, copyId, at, deadline);
          const at = await time();
          try {
            const before = await observed(at);
            const prepared = await ports.presentation(owner, before.fact, at, deadline, languages);
            const result = render
              ? await render(before.fact.copy, prepared.presentation, prepared.disclosure)
              : { ...before.fact.copy, presentation: prepared.presentation };
            const finalTime = await time();
            try {
              let sourceFailure: { error: unknown } | null = null;
              try {
                await prepared.verify(finalTime);
              } catch (error) {
                sourceFailure = { error };
              }
              // Recheck native owner authority even when a foreign source fence failed.
              const after = await observed(finalTime);
              if (before.epoch !== after.epoch || JSON.stringify(before.fact) !== JSON.stringify(after.fact))
                throw new CopyConflictError();
              if (sourceFailure) throw sourceFailure.error;
            } finally {
              ports.releaseTime(finalTime);
            }
            return result;
          } finally {
            ports.releaseTime(at);
          }
        }),
      ),
    );
  }

  async function listCopiesWithObservation(
    actor: LibraryActor,
    options: CopyPageOptions = {},
    languages: readonly string[] = [],
  ) {
    const owner = requireActor(actor, 'copy:list');
    const filterSubjectId = options.subjectId === undefined ? null : copySubjectId(options.subjectId);
    const filterKind = options.kind === undefined ? null : copyVocabularyValue(options.kind, 'kind');
    const filterStatus = options.status === undefined ? null : copyVocabularyValue(options.status, 'status');
    const size = options.limit ?? COPY_DEFAULT_LIMIT;
    if (!Number.isInteger(size) || size < 1 || size > COPY_MAX_LIMIT) throw new CopyInvalidError('limit');
    const accountRoute = ports.requireRoute(owner.accountId);
    const binding: CopyCursorBinding = {
      operation: 'copy.list',
      parameters: {
        accountId: owner.accountId,
        accountLifetime: owner.authnEpoch,
        clientId: owner.clientId,
        requestedBy: owner.requestedBy,
        route: accountRoute,
        subjectId: filterSubjectId,
        kind: filterKind,
        status: filterStatus,
        order: 'created_at:asc,copy_id:asc',
        basis: 'library.partition.epoch',
      },
    };
    const deadline = ports.deadline();
    const readPage = () =>
      ports.readOnly(
        owner,
        async (client) => {
          const partition = await ports.partition(client, accountRoute);
          let after: { createdAt: string; copyId: string } | null = null;
          if (options.cursor !== undefined) {
            const cursor = ports.decodeCursor(binding, options.cursor);
            const createdAt = cursor.ok ? cursor.after[0] : undefined;
            const cursorId = cursor.ok ? cursor.after[1] : undefined;
            if (
              !cursor.ok ||
              cursor.after.length !== 2 ||
              typeof createdAt !== 'string' ||
              !Number.isFinite(Date.parse(createdAt)) ||
              typeof cursorId !== 'string' ||
              routeOf(cursorId) !== accountRoute
            ) {
              throw ports.problem('invalid_cursor');
            }
            if (cursor.epoch !== partition?.epoch) throw ports.problem('stale_cursor');
            after = { createdAt, copyId: cursorId };
          }
          const rows = await ports.page(
            client,
            accountRoute,
            owner.accountId,
            { after, limit: Math.min(COPY_MAX_LIMIT, size + 1) },
            filterSubjectId,
            filterKind,
            filterStatus,
          );
          const copies = rows.slice(0, size);
          const last = copies.at(-1);
          let more = rows.length > size;
          if (!more && size === COPY_MAX_LIMIT && last) {
            const probe = await ports.page(
              client,
              accountRoute,
              owner.accountId,
              { after: { createdAt: last.createdAt, copyId: last.id }, limit: 1 },
              filterSubjectId,
              filterKind,
              filterStatus,
            );
            more = probe.length > 0;
          }
          const inventoryValues = await ports.inventoryValues(client, accountRoute, owner.accountId);
          return {
            copies,
            next:
              more && last && partition
                ? ports.encodeCursor(binding, { epoch: partition.epoch, after: [last.createdAt, last.id] })
                : null,
            accountEpoch: partition?.epoch ?? null,
            inventoryValues,
          };
        },
        deadline,
      );

    return ports.execute(
      ports.plans.inventory({
        route: accountRoute,
        accountId: owner.accountId,
        limit: size,
        subjectId: filterSubjectId,
        kind: filterKind,
        status: filterStatus,
        cursor: options.cursor ?? null,
      }),
      () =>
        ports.request(deadline, async () => {
          const first = await readPage();
          const filterOptions = await ports.inventory(first.inventoryValues, deadline, languages);
          const current = await readPage();
          if (
            JSON.stringify(first.copies) !== JSON.stringify(current.copies) ||
            first.next !== current.next ||
            first.accountEpoch !== current.accountEpoch ||
            JSON.stringify(first.inventoryValues) !== JSON.stringify(current.inventoryValues)
          )
            throw ports.problem('semantic_not_ready');
          return {
            copies: first.copies,
            next: first.next,
            accountEpoch: first.accountEpoch,
            filterOptions,
          };
        }),
    );
  }

  async function listCopies(actor: LibraryActor, options: CopyPageOptions = {}) {
    const { copies, next } = await listCopiesWithObservation(actor, options);
    return { copies, next };
  }

  return {
    createCopy,
    updateCopy,
    deleteCopy,
    restoreCopy,
    readCopy,
    readPresentedCopy,
    listCopies,
    listCopiesWithObservation,
  };
}
