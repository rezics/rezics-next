import { AuthenticationError } from '../access/contract/authentication.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import type { CursorBinding } from '../tokens/cursor.ts';
import { accessCheck } from './access-port.ts';
import { decodeAuthorItemKey, encodeAuthorItemKey } from './author-item-reads.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import { ContentNotFoundError, readPost, snapshot, type PostEntry, type RetainContentRead } from './reads.ts';
import {
  HOSTED_PAGE_LIMIT,
  InvalidHostedCursorError,
  InvalidHostedStructureError,
  HostedOwnerInventoryUnavailableError,
  type HostedDependencies,
  type HostedOwnerInventoryInput,
  type HostedOwnerInventoryEntry,
  type HostedOwnerInventoryScope,
  type HostedOwnerInventoryView,
} from './hosted-chapters-model.ts';
import {
  hostedOwnedCatalogue,
  hostedOwnedCataloguePage,
  type HostedOwnedCatalogueRow,
} from './hosted-chapters-store.ts';

/** As with own drafts, the acting account selects its own home, including an
 * organization. Current account admission enforces session, delegation and scopes. */
async function ownerAdmission(deps: HostedDependencies, accountId: string, context: ReadContext) {
  const actor = context.actor;
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const route = routeOf(accountId);
  if (route === null || accountId !== actor.accountId) throw new ContentNotFoundError();
  const check = await accessCheck(
    deps.access,
    actor,
    'account:read',
    { route, id: accountId },
    { pool: deps.pool, deadline: context.deadline },
  );
  let epoch: number | undefined;
  const verify = async () => {
    const current = await snapshot(deps, accountId, context, (client) => check(client));
    if (!current.value || (epoch !== undefined && current.anchor.epoch !== epoch)) throw new ContentNotFoundError();
    epoch ??= current.anchor.epoch;
    return current.anchor;
  };
  const anchor = await verify();
  const scope: HostedOwnerInventoryScope = { kind: 'same-home', route, crossHome: 'unavailable' };
  return { actor, route, scope, anchor, verify };
}

function cursorScope(admission: Awaited<ReturnType<typeof ownerAdmission>>, limit: number): CursorBinding {
  const { actor, route } = admission;
  return {
    operation: 'content.hosted-catalogue.owner.list',
    parameters: {
      accountId: actor.accountId,
      route,
      scope: 'same-home',
      limit,
      clientId: actor.clientId,
      requestedBy: actor.requestedBy,
      authnEpoch: actor.authnEpoch,
      scopes: [...actor.scopes].sort().join(' '),
    },
  };
}

async function prepareEntry(
  deps: HostedDependencies,
  accountId: string,
  row: HostedOwnedCatalogueRow,
  context: ReadContext,
  epoch: number,
) {
  const observation: { current?: Parameters<RetainContentRead<PostEntry>>[0] } = {};
  const initial = await readPost(deps, row.thread_id, row.catalogue_id, context, undefined, (current) => {
    observation.current = current;
  });
  if (
    initial.value?.availability !== 'available' ||
    initial.value.authorId !== accountId ||
    initial.anchor.epoch !== epoch ||
    !observation.current
  )
    return null;
  const revise = await accessCheck(
    deps.access,
    context.actor,
    'post:revise',
    { route: row.route, id: row.catalogue_id },
    { pool: deps.pool, deadline: context.deadline },
  );
  const retained = observation.current;
  // Keep metadata and native authority handles, never a page of document bodies.
  return async () => {
    const final = await retained(async (client) => {
      // Structure heads are private, even when a catalogue already has a release.
      if (!(await revise(client))) throw new ContentNotFoundError();
      const current = await hostedOwnedCatalogue(client, row.route, accountId, row.catalogue_id);
      if (
        !current ||
        current.thread_id !== row.thread_id ||
        current.created_at !== row.created_at ||
        current.head_revision_id !== row.head_revision_id ||
        current.publication_id !== row.publication_id
      )
        throw new ContentNotFoundError();
    });
    const post = final.value;
    if (
      post?.availability !== 'available' ||
      post.authorId !== accountId ||
      post.threadId !== row.thread_id ||
      final.anchor.epoch !== epoch ||
      post.visibility === 'taken_down'
    )
      return null;
    const value: HostedOwnerInventoryEntry = {
      catalogueId: row.catalogue_id,
      threadId: row.thread_id,
      createdAt: row.created_at,
      postRevisionId: post.revisionId,
      postVisibility: post.visibility,
      headRevisionId: row.head_revision_id,
      publicationId: row.publication_id,
    };
    return { value, anchor: final.anchor };
  };
}

/** <=21 actual owned catalogue records from one source route, <=20 native
 * disclosures. Denied or changed records consume their slots; never refill. */
export async function listOwnHostedCatalogues(
  deps: HostedDependencies,
  accountId: string,
  context: ReadContext,
  input: HostedOwnerInventoryInput = {},
) {
  const admission = await ownerAdmission(deps, accountId, context);
  if (input.scope === 'all-homes') throw new HostedOwnerInventoryUnavailableError();
  if (input.scope !== undefined && input.scope !== 'same-home') throw new InvalidHostedStructureError();
  const limit = input.limit ?? HOSTED_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PAGE_LIMIT) throw new InvalidHostedStructureError();
  const binding = cursorScope(admission, limit);
  const now = deps.clock().getTime();
  const selected = await snapshot(deps, accountId, context, async (client) => {
    const partition = await readPartition(client, partitionOf(admission.route));
    if (!partition || partition.epoch !== admission.anchor.epoch) throw new InvalidHostedCursorError();
    let after: { createdAt: string; itemId: string } | null = null;
    if (input.cursor !== undefined) {
      try {
        after = decodeAuthorItemKey(deps.tokens, binding, input.cursor, partition.epoch, now);
      } catch {
        throw new InvalidHostedCursorError();
      }
      if (routeOf(after.itemId) !== admission.route) throw new InvalidHostedCursorError();
    }
    return hostedOwnedCataloguePage(client, admission.route, accountId, after, limit + 1);
  });
  const anchors: AnchoredPosition[] = [admission.anchor, selected.anchor];
  const prepared: Array<NonNullable<Awaited<ReturnType<typeof prepareEntry>>>> = [];
  for (const row of selected.value.slice(0, limit)) {
    try {
      const entry = await prepareEntry(deps, accountId, row, context, selected.anchor.epoch);
      if (entry) prepared.push(entry);
    } catch (error) {
      if (!(error instanceof ContentNotFoundError)) throw error;
    }
  }
  anchors.push(await admission.verify());
  const items: HostedOwnerInventoryEntry[] = [];
  for (const finish of prepared) {
    try {
      const entry = await finish();
      if (entry) {
        items.push(entry.value);
        anchors.push(entry.anchor);
      }
    } catch (error) {
      if (!(error instanceof ContentNotFoundError)) throw error;
    }
  }
  const last = selected.value.slice(0, limit).at(-1);
  const value: HostedOwnerInventoryView = {
    scope: admission.scope,
    viewer: { accountId, authnEpoch: admission.actor.authnEpoch },
    items,
    // Encrypt the raw boundary: even a withheld candidate's ID and time stay private.
    nextCursor:
      selected.value.length > limit && last
        ? encodeAuthorItemKey(
            deps.tokens,
            binding,
            { createdAt: last.created_at, itemId: last.catalogue_id },
            selected.anchor.epoch,
            now,
          )
        : null,
  };
  return { value, anchors };
}

/** Resolve one inventory entry within its declared scope, without a supplied
 * thread or ownership claim. Existing hosted reads still accept known remote IDs;
 * this directory never infers cross-home coverage from those exact reads. */
export async function readOwnHostedCatalogue(
  deps: HostedDependencies,
  accountId: string,
  catalogueId: string,
  context: ReadContext,
) {
  const admission = await ownerAdmission(deps, accountId, context);
  const route = routeOf(catalogueId);
  if (route === null) throw new ContentNotFoundError();
  if (route !== admission.route) throw new HostedOwnerInventoryUnavailableError();
  const selected = await snapshot(deps, accountId, context, (client) =>
    hostedOwnedCatalogue(client, route, accountId, catalogueId),
  );
  if (!selected.value || selected.anchor.epoch !== admission.anchor.epoch) throw new ContentNotFoundError();
  const finish = await prepareEntry(deps, accountId, selected.value, context, selected.anchor.epoch);
  const accountAnchor = await admission.verify();
  const entry = await finish?.();
  if (!entry) throw new ContentNotFoundError();
  return {
    value: { scope: admission.scope, viewer: { accountId, authnEpoch: admission.actor.authnEpoch }, item: entry.value },
    anchors: [admission.anchor, selected.anchor, accountAnchor, entry.anchor],
  };
}
