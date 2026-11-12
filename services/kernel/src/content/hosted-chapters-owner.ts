import { AuthenticationError } from '../access/contract/authentication.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import type { CursorBinding } from '../tokens/cursor.ts';
import { accessCheck } from './access-port.ts';
import { decodeAuthorItemKey, encodeAuthorItemKey } from './author-item-cursor.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import { ContentNotFoundError, readPost, snapshot, type PostEntry, type RetainContentRead } from './reads.ts';
import {
  HOSTED_PAGE_LIMIT,
  InvalidHostedCursorError,
  InvalidHostedStructureError,
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
import { hostedLocatorCoverage } from './hosted-chapters-index.ts';
import locatorPage from './hosted-owned-catalogue-page.sql';

type Candidate = { item_id: string; thread_id: string; created_at: string };
type InventoryKind = NonNullable<HostedOwnerInventoryInput['scope']>;

/** As with own drafts, the acting account selects itself, including an
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
  return { actor, route, anchor, verify };
}

function inventoryScope(route: number, kind: InventoryKind, complete: boolean): HostedOwnerInventoryScope {
  return { kind, route, crossHome: kind === 'same-home' ? 'unavailable' : complete ? 'complete' : 'partial' };
}

function cursorScope(
  admission: Awaited<ReturnType<typeof ownerAdmission>>,
  limit: number,
  kind: InventoryKind,
): CursorBinding {
  const { actor, route } = admission;
  // Preserve the exact original same-home binding and encrypted boundary format.
  return {
    operation: 'content.hosted-catalogue.owner.list',
    parameters: {
      accountId: actor.accountId,
      route,
      scope: kind,
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
  source: AnchoredPosition,
  anchors: AnchoredPosition[],
) {
  const observation: { current?: Parameters<RetainContentRead<PostEntry>>[0] } = {};
  const initial = await readPost(deps, row.thread_id, row.catalogue_id, context, undefined, (current) => {
    observation.current = current;
  });
  anchors.push(initial.anchor);
  if (
    initial.value?.availability !== 'available' ||
    initial.value.authorId !== accountId ||
    initial.anchor.partition.partitionNo !== source.partition.partitionNo ||
    initial.anchor.epoch !== source.epoch ||
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
  const revisionId = initial.value.revisionId;
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
    anchors.push(final.anchor);
    const post = final.value;
    if (
      post?.availability !== 'available' ||
      post.authorId !== accountId ||
      post.threadId !== row.thread_id ||
      post.revisionId !== revisionId ||
      final.anchor.partition.partitionNo !== source.partition.partitionNo ||
      final.anchor.epoch !== source.epoch ||
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
    return value;
  };
}

/** A locator candidate contains no head or release claim. Open only its exact
 * Post home, retain that partition's anchor and recheck current native ownership.
 * A different source cannot replace the indexed key, thread or creation time. */
async function prepareCandidate(
  deps: HostedDependencies,
  accountId: string,
  candidate: Candidate,
  context: ReadContext,
  anchors: AnchoredPosition[],
) {
  const selected = await snapshot(deps, candidate.item_id, context, (client) =>
    hostedOwnedCatalogue(client, routeOf(candidate.item_id)!, accountId, candidate.item_id),
  );
  anchors.push(selected.anchor);
  const row = selected.value;
  if (!row || row.thread_id !== candidate.thread_id || row.created_at !== candidate.created_at) return null;
  return prepareEntry(deps, accountId, row, context, selected.anchor, anchors);
}

/** <=21 indexed raw candidates, <=20 native disclosures. Hidden or changed
 * sources consume their slots. The raw encrypted boundary continues sparse pages. */
export async function listOwnHostedCatalogues(
  deps: HostedDependencies,
  accountId: string,
  context: ReadContext,
  input: HostedOwnerInventoryInput = {},
) {
  const admission = await ownerAdmission(deps, accountId, context);
  const kind = input.scope ?? 'same-home';
  if (kind !== 'same-home' && kind !== 'all-homes') throw new InvalidHostedStructureError();
  const limit = input.limit ?? HOSTED_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PAGE_LIMIT) throw new InvalidHostedStructureError();
  const binding = cursorScope(admission, limit, kind);
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
      if (kind === 'same-home' && routeOf(after.itemId) !== admission.route) throw new InvalidHostedCursorError();
    }
    if (kind === 'same-home') {
      const rows = await hostedOwnedCataloguePage(client, admission.route, accountId, after, limit + 1);
      return {
        rows,
        candidates: rows.map((row) => ({
          item_id: row.catalogue_id, thread_id: row.thread_id, created_at: row.created_at,
        })),
        complete: false,
      };
    }
    const parameters = {
      route: admission.route,
      account_id: accountId,
      after_at: after?.createdAt ?? 'infinity',
      after_id: after?.itemId ?? '00000000-0000-0000-0000-000000000000',
      limit: limit + 1,
    };
    const candidates = await client.query<Candidate>(
      locatorPage.sql,
      locatorPage.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    return { rows: null, candidates: candidates.rows, complete: await hostedLocatorCoverage(client, accountId) };
  });
  const anchors: AnchoredPosition[] = [admission.anchor, selected.anchor];
  const prepared: Array<NonNullable<Awaited<ReturnType<typeof prepareEntry>>>> = [];
  for (let index = 0; index < Math.min(limit, selected.value.candidates.length); index++) {
    try {
      const row = selected.value.rows?.[index];
      const entry = row
        ? await prepareEntry(deps, accountId, row, context, selected.anchor, anchors)
        : await prepareCandidate(deps, accountId, selected.value.candidates[index]!, context, anchors);
      if (entry) prepared.push(entry);
    } catch (error) {
      if (!(error instanceof ContentNotFoundError)) throw error;
    }
  }
  let complete = selected.value.complete;
  if (kind === 'all-homes') {
    const coverage = await snapshot(deps, accountId, context, (client) => hostedLocatorCoverage(client, accountId));
    anchors.push(coverage.anchor);
    complete &&= coverage.value && coverage.anchor.epoch === selected.anchor.epoch;
  }
  anchors.push(await admission.verify());
  const items: HostedOwnerInventoryEntry[] = [];
  // Native sources close last, after account and coverage work. Do not hydrate a
  // replacement page if a catalogue changes during those foreign observations.
  for (const finish of prepared) {
    try {
      const entry = await finish();
      if (entry) items.push(entry);
    } catch (error) {
      if (!(error instanceof ContentNotFoundError)) throw error;
    }
  }
  const last = selected.value.candidates.slice(0, limit).at(-1);
  const value: HostedOwnerInventoryView = {
    scope: inventoryScope(admission.route, kind, complete),
    viewer: { accountId, authnEpoch: admission.actor.authnEpoch },
    items,
    // Encrypt the raw boundary: even a withheld candidate's ID and time stay private.
    nextCursor:
      selected.value.candidates.length > limit && last
        ? encodeAuthorItemKey(
            deps.tokens,
            binding,
            { createdAt: last.created_at, itemId: last.item_id },
            selected.anchor.epoch,
            now,
          )
        : null,
  };
  return { value, anchors };
}

/** An exact owner selection needs no locator coverage claim. Native membership,
 * author and revise authority are proved in the catalogue's own current home. */
export async function readOwnHostedCatalogue(
  deps: HostedDependencies,
  accountId: string,
  catalogueId: string,
  context: ReadContext,
) {
  const admission = await ownerAdmission(deps, accountId, context);
  const route = routeOf(catalogueId);
  if (route === null) throw new ContentNotFoundError();
  const selected = await snapshot(deps, catalogueId, context, (client) =>
    hostedOwnedCatalogue(client, route, accountId, catalogueId),
  );
  const anchors = [admission.anchor, selected.anchor];
  if (!selected.value) throw new ContentNotFoundError();
  const finish = await prepareEntry(deps, accountId, selected.value, context, selected.anchor, anchors);
  const kind = route === admission.route ? 'same-home' : 'all-homes';
  let complete = false;
  if (kind === 'all-homes') {
    const coverage = await snapshot(deps, accountId, context, (client) => hostedLocatorCoverage(client, accountId));
    anchors.push(coverage.anchor);
    complete = coverage.value;
  }
  anchors.push(await admission.verify());
  const entry = await finish?.();
  if (!entry) throw new ContentNotFoundError();
  return {
    value: {
      scope: inventoryScope(admission.route, kind, complete),
      viewer: { accountId, authnEpoch: admission.actor.authnEpoch },
      item: entry,
    },
    anchors,
  };
}
