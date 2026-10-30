import { semanticCopyRoles } from './erasure-producer.ts';
import { privateLinks, refreshStatementReaderAuthorization } from './statement-disclosure.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import type { Release } from '@rezics/definitions';
import { activeRelease, GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { readItemTypes, readLabels } from './subject.ts';
import { languageRanges } from './language.ts';
import { holderFacts, labelOrderKey, readHolderKeys } from './link-keys.ts';
import { factDataTypes, resolveItem, type Statement } from './item.ts';
import { contextLinkChanges, linkChanges } from './link-changes.ts';
import { slotView } from './slots.ts';
import { contextSnapshot } from './context.ts';
import { readSubjectSummaries, type SubjectSummary, type SummaryDependencies } from './summaries.ts';
import { matchesTarget } from './targets.ts';
import readInboundLinkCount from './read-inbound-link-count.sql';
import countInboundLinkTypes from './count-inbound-link-types.sql';
import { withReadTransaction } from './read.ts';
import type { Pool, PoolClient } from 'pg';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { projectBatch, type Envelope } from '../events/log.ts';
import type { Relay } from '../events/relays.ts';
import { readPartition } from '../partition/partition.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SessionComponent } from '../tokens/session.ts';
import type { AccessCheck } from '../request/access.ts';
import { SubjectNotFoundError } from './candidates.ts';
import { moveMergePage } from './merge-moves.ts';
import { redirectOf, SubjectRedirectError } from './merges.ts';
import { accountAgentsForSubjects } from './agents.ts';
import {
  LINK_KEYS_CHANGED,
  LINKS_MOVING,
  LINKS_VISIBILITY_CHANGED,
  SUBJECT_MERGED,
  LINKS_CHANGED,
  LINKS_PROJECTED,
} from './events.ts';
import listInboundLinksByProperty from './list-inbound-links-by-property.sql';
import listInboundLinks from './list-inbound-links.sql';
import { PageCursorError } from './page.ts';
import { pendingMergeSources, waitForSubjectLinks } from './link-freshness.ts';
export { waitForSubjectLinks } from './link-freshness.ts';
import readVisibility from './read-visibility.sql';
import upsertInboundLinks from './upsert-inbound-links.sql';
import upsertOutboundLinks from './upsert-outbound-links.sql';
import listOutboundLinksByProperty from './list-outbound-links-by-property.sql';
import readOutboundLinkCount from './read-outbound-link-count.sql';
import countOutboundLinkTypes from './count-outbound-link-types.sql';
import listOutboundKeyReemit from './list-outbound-key-reemit.sql';
import listInboundKeyReemit from './list-inbound-key-reemit.sql';
import readOutboundForTargetReemit from './read-outbound-for-target-reemit.sql';
import listOutboundVisibility from './list-outbound-visibility.sql';

export const LINKS_CONSUMER = 'semantic_links';
const FRESHNESS_TARGET_SECONDS = 10;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type LinkChangeRow = {
  context_id?: string;
  suppressed?: boolean;
  property: string;
  statement: string;
  target: string | null;
  present: boolean;
  project_outbound?: boolean;
  relation?: boolean;
  slot_id?: string;
  external?: string | null;
  value?: 'value' | 'somevalue' | 'novalue';
  outbound_order?: 'position' | 'date' | 'name' | null;
  outbound_order_key?: string;
  source_type?: string;
  order_key?: string;
  filter_value?: string;
};
type LinksChanged = { subject: string; revision: number; security_revision: number; changes: LinkChangeRow[] };
type LinkKeysChanged = {
  subject: string;
  direction: 'holder' | 'target';
  revision: number;
  security_revision: number;
  cursor: (string | number)[];
};
type LinksVisibilityChanged = {
  subject: string;
  revision: number;
  security_revision: number;
  release: string;
  visible: boolean;
  cursor: (string | number)[];
};
type StoredChange = {
  context_id?: string;
  suppressed?: boolean;
  route: number;
  subjectId: string;
  property: string;
  sourceSubjectId: string;
  statementId: string;
  sourceRevision: number;
  sourceSecurityRevision: number;
  present: boolean;
  position: bigint;
  sourceType: string;
  orderKey: string;
  filterValue: string;
};
type StoredOutboundChange = {
  context_id?: string;
  suppressed?: boolean;
  route: number;
  subjectId: string;
  property: string;
  statementId: string;
  target: string | null;
  targetOrderKey?: string;
  targetRevision?: number;
  targetType?: string;
  slotId: string;
  relation: boolean;
  external: string | null;
  value: 'value' | 'somevalue' | 'novalue';
  outboundOrder: 'position' | 'date' | 'name' | null;
  outboundOrderKey: string;
  sourceType: string;
  sourceOrderKey: string;
  sourceRevision: number;
  sourceSecurityRevision: number;
  present: boolean;
  position: bigint;
  filterValue: string;
};

function olderChange(revision: number, security: number, position: bigint, current: StoredChange): boolean {
  if (revision !== current.sourceRevision) return revision < current.sourceRevision;
  if (security !== current.sourceSecurityRevision) return security < current.sourceSecurityRevision;
  return position < current.position;
}

function preferredChange(change: StoredChange, current: StoredChange): boolean {
  if (change.sourceRevision !== current.sourceRevision) return change.sourceRevision > current.sourceRevision;
  if (change.sourceSecurityRevision !== current.sourceSecurityRevision)
    return change.sourceSecurityRevision > current.sourceSecurityRevision;
  return change.position >= current.position;
}

function newestChanges(envelopes: readonly Envelope[]): Map<number, StoredChange[]> {
  const newest = new Map<string, StoredChange>();
  for (const envelope of envelopes) {
    for (const event of envelope.events) {
      if (event.type !== LINKS_CHANGED) continue;
      const data = event.data as LinksChanged;
      const security = Number(data.security_revision);
      for (const change of data.changes) {
        if (change.target === null) continue;
        const route = routeOf(change.target);
        if (route === null) continue;
        const key = `${change.context_id ?? GLOBAL_CONTEXT}\0${route}\0${change.target}\0${change.property}\0${data.subject}\0${change.statement}\0${change.filter_value ?? NIL_UUID}`;
        const current = newest.get(key);
        if (current && olderChange(data.revision, security, envelope.position, current)) continue;
        newest.set(key, {
          context_id: change.context_id ?? GLOBAL_CONTEXT,
          suppressed: change.suppressed ?? false,
          route,
          subjectId: change.target,
          property: change.property,
          sourceSubjectId: data.subject,
          statementId: change.statement,
          sourceRevision: data.revision,
          sourceSecurityRevision: security,
          present: change.present,
          position: envelope.position,
          sourceType: change.source_type ?? '',
          orderKey: change.order_key ?? '',
          filterValue: change.filter_value ?? NIL_UUID,
        });
      }
    }
  }
  const grouped = new Map<number, StoredChange[]>();
  for (const change of newest.values()) {
    const partition = partitionOf(change.route);
    const list = grouped.get(partition) ?? [];
    list.push(change);
    grouped.set(partition, list);
  }
  return grouped;
}

function newestOutboundChanges(envelopes: readonly Envelope[]): Map<number, StoredOutboundChange[]> {
  const newest = new Map<string, StoredOutboundChange>();
  for (const envelope of envelopes) {
    for (const event of envelope.events) {
      if (event.type !== LINKS_CHANGED) continue;
      const data = event.data as LinksChanged;
      const holder = routeOf(data.subject);
      if (holder === null) continue;
      const security = Number(data.security_revision);
      for (const change of data.changes) {
        if (!change.project_outbound || !change.slot_id) continue;
        const key = `${change.context_id ?? GLOBAL_CONTEXT}\0${data.subject}\0${change.property}\0${change.statement}\0${change.target ?? ''}\0${change.external ?? ''}\0${change.filter_value ?? NIL_UUID}`;
        const current = newest.get(key);
        if (
          current &&
          olderChange(data.revision, security, envelope.position, {
            route: holder,
            subjectId: data.subject,
            property: change.property,
            sourceSubjectId: data.subject,
            statementId: change.statement,
            sourceRevision: current.sourceRevision,
            sourceSecurityRevision: current.sourceSecurityRevision,
            present: current.present,
            position: current.position,
            sourceType: current.sourceType,
            orderKey: current.sourceOrderKey,
            filterValue: current.filterValue,
          })
        )
          continue;
        newest.set(key, {
          context_id: change.context_id ?? GLOBAL_CONTEXT,
          suppressed: change.suppressed ?? false,
          route: holder,
          subjectId: data.subject,
          property: change.property,
          statementId: change.statement,
          target: change.target,
          slotId: change.slot_id,
          relation: change.relation === true,
          external: change.external ?? null,
          value: change.value ?? (change.target === null ? 'somevalue' : 'value'),
          outboundOrder: change.outbound_order ?? null,
          outboundOrderKey: change.outbound_order_key ?? '',
          sourceType: change.source_type ?? '',
          sourceOrderKey: change.order_key ?? '',
          sourceRevision: data.revision,
          sourceSecurityRevision: security,
          present: change.present,
          position: envelope.position,
          filterValue: change.filter_value ?? NIL_UUID,
        });
      }
    }
  }
  const grouped = new Map<number, StoredOutboundChange[]>();
  for (const change of newest.values()) {
    const partition = partitionOf(change.route);
    const list = grouped.get(partition) ?? [];
    list.push(change);
    grouped.set(partition, list);
  }
  return grouped;
}

async function applyChanges(pool: Pool, changes: StoredChange[]): Promise<void> {
  const contexts = [...new Set(changes.map((change) => change.context_id ?? GLOBAL_CONTEXT))];
  if (contexts.length > 1) {
    contexts.sort((left, right) =>
      left === GLOBAL_CONTEXT ? -1 : right === GLOBAL_CONTEXT ? 1 : left.localeCompare(right),
    );
    for (const context of contexts)
      await applyChanges(
        pool,
        changes.filter((change) => (change.context_id ?? GLOBAL_CONTEXT) === context),
      );
    return;
  }
  const newest = new Map<string, StoredChange>();
  for (const change of changes) {
    const key = JSON.stringify([
      change.subjectId,
      change.context_id ?? GLOBAL_CONTEXT,
      change.property,
      change.sourceSubjectId,
      change.statementId,
      change.filterValue,
    ]);
    const current = newest.get(key);
    if (!current || preferredChange(change, current)) newest.set(key, change);
  }
  changes = [...newest.values()];
  // A command checks each target under the same partition fence as its upserts.
  for (let offset = 0; offset < changes.length; offset += 100) {
    const page = changes.slice(offset, offset + 100);
    const roles = await Promise.all(page.map(change => semanticCopyRoles(pool,change.sourceSubjectId,change.statementId)));
    const partition = partitionOf(page[0]!.route);
    const command = await runCommand(pool, { partition }, async (tx, { transactionId }) => {
      const forwarded: StoredChange[] = [];
      const local: StoredChange[] = [];
      for (const change of page) {
        const redirect = await redirectOf(tx, change.subjectId);
        if (redirect) forwarded.push({ ...change, subjectId: redirect, route: routeOf(redirect)! });
        else local.push(change);
      }
      // One upsert per target route: the statement binds a single route parameter.
      for (const route of [...new Set(local.map((change) => change.route))].sort((a, b) => a - b))
        await upsertInboundLinks.run(tx, {
          route,
          transaction_id: transactionId,
          changes: local
            .filter((change) => change.route === route)
            .map((change) => ({
              erasure_roles: roles[page.indexOf(change)] ?? [],
              subject_id: change.subjectId,
              context_id: change.context_id ?? GLOBAL_CONTEXT,
              suppressed: change.suppressed ?? false,
              property: change.property,
              source_subject_id: change.sourceSubjectId,
              statement_id: change.statementId,
              source_revision: change.sourceRevision,
              source_security_revision: change.sourceSecurityRevision,
              present: change.present,
              source_type: change.sourceType,
              order_key: change.orderKey,
              filter_value: change.filterValue,
            })),
        });
      return {
        value: forwarded,
        events: local.length
          ? [
              {
                type: LINKS_PROJECTED,
                data: { subjects: [...new Set(local.map((change) => change.subjectId))].sort() },
              },
            ]
          : [{ type: LINKS_PROJECTED, data: { subjects: [...new Set(page.map((change) => change.subjectId))] } }],
      };
    });
    const groups = new Map<number, StoredChange[]>();
    for (const change of command.value) {
      const partition = partitionOf(change.route);
      const group = groups.get(partition) ?? [];
      group.push(change);
      groups.set(partition, group);
    }
    for (const group of groups.values()) await applyChanges(pool, group);
  }
}

async function applyOutboundChanges(pool: Pool, changes: StoredOutboundChange[]): Promise<void> {
  const contexts = [...new Set(changes.map((change) => change.context_id ?? GLOBAL_CONTEXT))];
  if (contexts.length > 1) {
    contexts.sort((left, right) =>
      left === GLOBAL_CONTEXT ? -1 : right === GLOBAL_CONTEXT ? 1 : left.localeCompare(right),
    );
    for (const context of contexts)
      await applyOutboundChanges(
        pool,
        changes.filter((change) => (change.context_id ?? GLOBAL_CONTEXT) === context),
      );
    return;
  }
  const routes = new Map<number, StoredOutboundChange[]>();
  for (const change of changes) {
    const group = routes.get(change.route) ?? [];
    group.push(change);
    routes.set(change.route, group);
  }
  for (const [route, routeChanges] of routes) {
    for (let offset = 0; offset < routeChanges.length; offset += 100) {
      const page = routeChanges.slice(offset, offset + 100);
      const typeTargets = page.flatMap((change) =>
        change.target && change.targetType === undefined ? [change.target] : [],
      );
      const nameTargets = page.flatMap((change) =>
        change.target && change.targetOrderKey === undefined && change.outboundOrder === 'name' ? [change.target] : [],
      );
      const dateTargets = [
        ...new Set(
          page.flatMap((change) =>
            change.target && change.targetOrderKey === undefined && change.outboundOrder === 'date'
              ? [change.target]
              : [],
          ),
        ),
      ];
      const [types, labels] = await Promise.all([
        readItemTypes(pool, [...new Set(typeTargets)]),
        readLabels(pool, [...new Set(nameTargets)]),
      ]);
      const dateKeys = new Map(
        await Promise.all(
          dateTargets.map(async (target) => [target, (await readHolderKeys(pool, target)).date] as const),
        ),
      );
      const roles = await Promise.all(page.map(change => semanticCopyRoles(pool,change.subjectId,change.statementId)));
      await runCommand(pool, { partition: partitionOf(route) }, async (tx, { transactionId }) => {
        await upsertOutboundLinks.run(tx, {
          route,
          transaction_id: transactionId,
          changes: page.map((change) => {
            const target = change.target;
            const unresolved = target === null;
            const external = change.external;
            const targetOrder =
              change.targetOrderKey ??
              (unresolved
                ? `Z${change.outboundOrderKey}\u0001${external ?? ''}`
                : change.outboundOrder === 'name'
                  ? labelOrderKey(labels.get(target) ?? {})
                  : change.outboundOrder === 'position'
                    ? change.outboundOrderKey
                    : change.outboundOrder === 'date'
                      ? (dateKeys.get(target) ?? '1')
                      : target);
            return {
              erasure_roles: roles[page.indexOf(change)] ?? [],
              subject_id: change.subjectId,
              context_id: change.context_id ?? GLOBAL_CONTEXT,
              suppressed: change.suppressed ?? false,
              property: change.property,
              filter_value: change.filterValue,
              order_key: targetOrder,
              target_subject_id: target ?? NIL_UUID,
              statement_id: change.statementId,
              slot_id: change.slotId,
              relation: change.relation,
              source_type: change.sourceType,
              source_order_key: change.sourceOrderKey,
              outbound_order: change.outboundOrder,
              source_revision: change.sourceRevision,
              source_security_revision: change.sourceSecurityRevision,
              target_revision: change.targetRevision ?? 0,
              target_type: change.targetType ?? (target ? (types.get(target) ?? '') : ''),
              external,
              value: change.value,
              present: change.present,
            };
          }),
        });
        return {
          value: null,
          events: [{ type: LINKS_PROJECTED, data: { subjects: [...new Set(page.map((change) => change.subjectId))] } }],
        };
      });
    }
  }
}

function sourceOrder(order: string | null, keys: { name: string; date: string }, prior: string): string {
  if (order === 'name') return keys.name;
  if (order === 'date') return keys.date;
  if (order === 'position') return prior;
  return '';
}

type OutboundProjectionRow = {
  context_id: string;
  suppressed: boolean;
  route: number;
  subject_id: string;
  property: string;
  statement_id: string;
  slot_id: string;
  target: string | null;
  filter_value: string;
  order_key: string;
  relation: boolean;
  source_type: string;
  source_order_key: string;
  outbound_order: string | null;
  source_revision: number;
  source_security_revision: string;
  target_revision: number;
  target_type: string;
  external: string | null;
  value: string;
};

function outboundProjectionRow(row: OutboundProjectionRow): StoredOutboundChange {
  return {
    context_id: String(row.context_id ?? GLOBAL_CONTEXT),
    suppressed: row.suppressed === true,
    route: Number(row.route),
    subjectId: String(row.subject_id),
    property: String(row.property),
    statementId: String(row.statement_id),
    target: typeof row.target === 'string' ? row.target : null,
    slotId: String(row.slot_id),
    relation: row.relation === true,
    external: typeof row.external === 'string' ? row.external : null,
    value: row.value === 'novalue' || row.value === 'somevalue' ? row.value : 'value',
    outboundOrder:
      row.outbound_order === 'name' || row.outbound_order === 'date' || row.outbound_order === 'position'
        ? row.outbound_order
        : null,
    outboundOrderKey: String(row.outbound_order === 'position' ? (row.source_order_key ?? '') : ''),
    sourceType: String(row.source_type ?? ''),
    sourceOrderKey: String(row.source_order_key ?? ''),
    sourceRevision: Number(row.source_revision),
    sourceSecurityRevision: Number(row.source_security_revision ?? 0),
    targetRevision: Number(row.target_revision ?? 0),
    targetType: String(row.target_type ?? ''),
    targetOrderKey: String(row.order_key ?? ''),
    present: true,
    position: 0n,
    filterValue: String(row.filter_value),
  };
}

async function enqueueKeyContinuation(pool: Pool, data: LinkKeysChanged): Promise<void> {
  const route = routeOf(data.subject);
  if (route === null) return;
  await runCommand(pool, { partition: partitionOf(route) }, async () => ({
    value: null,
    events: [{ type: LINK_KEYS_CHANGED, subject: data.subject, data }],
  }));
}

async function reemitHolderKeys(pool: Pool, data: LinkKeysChanged): Promise<void> {
  const route = routeOf(data.subject)!;
  const [afterProperty, afterTarget, afterStatement, afterFilter] = data.cursor;
  const rows = (await listOutboundKeyReemit.run(pool, {
    route,
    subject_id: data.subject,
    after_property: typeof afterProperty === 'string' ? afterProperty : '',
    after_target: typeof afterTarget === 'string' ? afterTarget : NIL_UUID,
    after_statement: typeof afterStatement === 'string' ? afterStatement : NIL_UUID,
    after_filter: typeof afterFilter === 'string' ? afterFilter : NIL_UUID,
    after_context: typeof data.cursor[4] === 'string' ? data.cursor[4] : NIL_UUID,
  })) as Omit<OutboundProjectionRow, 'route' | 'subject_id'>[];
  const page = rows.slice(0, 100);
  if (page.length === 0) return;
  const keys = await readHolderKeys(pool, data.subject);
  const outbound = page.map((raw) => {
    const row = outboundProjectionRow({ ...raw, subject_id: data.subject, route });
    row.sourceType = keys.source_type;
    row.sourceOrderKey = sourceOrder(row.outboundOrder, keys, row.sourceOrderKey);
    row.sourceRevision = data.revision;
    row.sourceSecurityRevision = data.security_revision;
    return row;
  });
  await applyOutboundChanges(pool, outbound);
  await applyChanges(
    pool,
    outbound.flatMap((change): StoredChange[] =>
      change.target === null
        ? []
        : [
            {
              route: routeOf(change.target)!,
              subjectId: change.target,
              context_id: change.context_id ?? GLOBAL_CONTEXT,
              suppressed: change.suppressed ?? false,
              property: change.property,
              sourceSubjectId: data.subject,
              statementId: change.statementId,
              sourceRevision: data.revision,
              sourceSecurityRevision: data.security_revision,
              present: true,
              position: 0n,
              sourceType: keys.source_type,
              orderKey: change.sourceOrderKey,
              filterValue: change.filterValue,
            },
          ],
    ),
  );
  if (rows.length > page.length) {
    const last = page.at(-1)!;
    await enqueueKeyContinuation(pool, {
      ...data,
      cursor: [
        String(last.property),
        typeof last.target === 'string' ? last.target : NIL_UUID,
        String(last.statement_id),
        String(last.filter_value),
        String(last.context_id),
      ],
    });
  }
}

async function reemitTargetKeys(pool: Pool, data: LinkKeysChanged): Promise<void> {
  const route = routeOf(data.subject)!;
  const [afterProperty, afterSource, afterStatement, afterFilter] = data.cursor;
  const inboundRows = await listInboundKeyReemit.run(pool, {
    route,
    subject_id: data.subject,
    after_property: typeof afterProperty === 'string' ? afterProperty : '',
    after_source: typeof afterSource === 'string' ? afterSource : NIL_UUID,
    after_statement: typeof afterStatement === 'string' ? afterStatement : NIL_UUID,
    after_filter: typeof afterFilter === 'string' ? afterFilter : NIL_UUID,
    after_context: typeof data.cursor[4] === 'string' ? data.cursor[4] : NIL_UUID,
  });
  const page = inboundRows.slice(0, 100) as {
    property: string;
    source: string;
    context_id: string;
    statement: string;
    filter_value: string;
  }[];
  if (page.length === 0) return;
  const keys = await readHolderKeys(pool, data.subject);
  const targetType = keys.source_type;
  const byRoute = new Map<number, typeof page>();
  for (const row of page) {
    const holderRoute = routeOf(row.source);
    if (holderRoute === null) continue;
    const group = byRoute.get(holderRoute) ?? [];
    group.push(row);
    byRoute.set(holderRoute, group);
  }
  const found = (
    await Promise.all(
      [...byRoute].map(([holderRoute, rows]) =>
        readOutboundForTargetReemit.run(pool, {
          route: holderRoute,
          links: rows.map((row) => ({
            subject_id: row.source,
            context_id: row.context_id,
            property: row.property,
            statement_id: row.statement,
            filter_value: row.filter_value,
          })),
        }),
      ),
    )
  ).flat() as OutboundProjectionRow[];
  const outbound = found.map((raw) => {
    const row = outboundProjectionRow(raw);
    row.targetType = targetType;
    row.targetRevision = data.revision;
    row.targetOrderKey =
      row.outboundOrder === 'name'
        ? keys.name
        : row.outboundOrder === 'date'
          ? keys.date
          : row.outboundOrder === 'position'
            ? row.outboundOrderKey
            : data.subject;
    return row;
  });
  await applyOutboundChanges(pool, outbound);
  if (inboundRows.length > page.length) {
    const last = page.at(-1)!;
    await enqueueKeyContinuation(pool, {
      ...data,
      cursor: [last.property, last.source, last.statement, last.filter_value, last.context_id],
    });
  }
}

async function enqueueVisibilityContinuation(pool: Pool, data: LinksVisibilityChanged): Promise<void> {
  const route = routeOf(data.subject);
  if (route === null) return;
  await runCommand(pool, { partition: partitionOf(route) }, async () => ({
    value: null,
    events: [{ type: LINKS_VISIBILITY_CHANGED, subject: data.subject, data }],
  }));
}

async function applyVisibilityPage(pool: Pool, data: LinksVisibilityChanged): Promise<void> {
  const route = routeOf(data.subject)!;
  const [afterProperty, afterTarget, afterStatement, afterFilter] = data.cursor;
  const rows = (await listOutboundVisibility.run(pool, {
    route,
    subject_id: data.subject,
    visible: data.visible,
    after_property: typeof afterProperty === 'string' ? afterProperty : '',
    after_target: typeof afterTarget === 'string' ? afterTarget : NIL_UUID,
    after_statement: typeof afterStatement === 'string' ? afterStatement : NIL_UUID,
    after_filter: typeof afterFilter === 'string' ? afterFilter : NIL_UUID,
    after_context: typeof data.cursor[4] === 'string' ? data.cursor[4] : NIL_UUID,
  })) as (Omit<OutboundProjectionRow, 'route' | 'subject_id' | 'statement_id' | 'slot_id'> & {
    statement: string;
    slot: string;
  })[];
  const page = rows.slice(0, 100);
  if (page.length === 0) return;
  const release = await readRelease(pool, data.release);
  if (!release) throw new Error('Subject revision release is missing');
  const keys = await readHolderKeys(pool, data.subject);
  let changes: StoredOutboundChange[];
  if (!data.visible) {
    changes = page.map((raw) => {
      const row = outboundProjectionRow({
        ...raw,
        subject_id: data.subject,
        route,
        statement_id: raw.statement,
        slot_id: raw.slot,
      });
      row.sourceRevision = data.revision;
      row.sourceSecurityRevision = data.security_revision;
      row.present = false;
      return row;
    });
  } else {
    const slots = new Map<string, { property: string; slot: string; context: string }>();
    for (const row of page) {
      const entry = { property: String(row.property), slot: String(row.slot), context: String(row.context_id) };
      slots.set(`${entry.property}\0${entry.slot}\0${entry.context}`, entry);
    }
    const identity = await withConnection(pool, (client) => holderFacts(client, data.subject, release));
    const metadata = { subject: data.subject, release, type: identity.type, identityFacts: identity.facts };
    const links = await withConnection(pool, async (client) => {
      const result = [];
      for (const { property, slot, context } of slots.values()) {
        const global = (await slotView(client, data.subject, property, GLOBAL_CONTEXT, {}, slot)).facts;
        if (context === GLOBAL_CONTEXT) {
          result.push(...linkChanges([], global, factDataTypes(release, global), metadata));
        } else {
          const selected = (await slotView(client, data.subject, property, context, {}, slot)).facts;
          result.push(
            ...contextLinkChanges(
              global,
              global,
              selected,
              factDataTypes(release, [...global, ...selected]),
              metadata,
              context,
            ),
          );
        }
      }
      return result;
    });
    changes = links.map((link) => ({
      route,
      subjectId: data.subject,
      context_id: link.context_id ?? GLOBAL_CONTEXT,
      suppressed: link.suppressed ?? false,
      property: link.property,
      statementId: link.statement,
      target: link.target,
      slotId: link.slot_id ?? '',
      relation: link.relation === true,
      external: link.external ?? null,
      value: link.value ?? (link.target === null ? 'somevalue' : 'value'),
      outboundOrder: link.outbound_order ?? null,
      outboundOrderKey: link.outbound_order_key ?? '',
      sourceType: keys.source_type,
      sourceOrderKey: link.order_key ?? '',
      sourceRevision: data.revision,
      sourceSecurityRevision: data.security_revision,
      present: true,
      position: 0n,
      filterValue: link.filter_value ?? NIL_UUID,
    }));
  }
  await applyOutboundChanges(pool, changes);
  await applyChanges(
    pool,
    changes.flatMap((change): StoredChange[] =>
      change.target === null
        ? []
        : [
            {
              route: routeOf(change.target)!,
              subjectId: change.target,
              context_id: change.context_id ?? GLOBAL_CONTEXT,
              suppressed: change.suppressed ?? false,
              property: change.property,
              sourceSubjectId: data.subject,
              statementId: change.statementId,
              sourceRevision: data.revision,
              sourceSecurityRevision: data.security_revision,
              present: change.present,
              position: 0n,
              sourceType: change.sourceType,
              orderKey: change.sourceOrderKey,
              filterValue: change.filterValue,
            },
          ],
    ),
  );
  if (rows.length > page.length) {
    const last = page.at(-1)!;
    await enqueueVisibilityContinuation(pool, {
      ...data,
      cursor: [
        String(last.property),
        typeof last.target === 'string' ? last.target : NIL_UUID,
        String(last.statement),
        String(last.filter_value),
        String(last.context_id),
      ],
    });
  }
}

async function applyLinkBatch(pool: Pool, envelopes: readonly Envelope[]): Promise<void> {
  const outbound = newestOutboundChanges(envelopes);
  for (const partition of [...outbound.keys()].sort((a, b) => a - b))
    await applyOutboundChanges(pool, outbound.get(partition)!);
  const grouped = newestChanges(envelopes);
  for (const partition of [...grouped.keys()].sort((a, b) => a - b)) {
    await applyChanges(pool, grouped.get(partition)!);
  }
  const merges = envelopes.flatMap((envelope) =>
    envelope.events.flatMap((event) => {
      if (event.type !== SUBJECT_MERGED) return [];
      const data = event.data as { id: string; survivor: string };
      return [data];
    }),
  );
  const agentLinks = await accountAgentsForSubjects(
    pool,
    merges.map((event) => event.survivor),
  );
  const verificationBySubject = new Map<string, { account: string; receipt: string }>();
  for (const event of merges) {
    const link = agentLinks.get(event.survivor);
    if (link?.verified && link.receipt_id && link.agent_id === event.id)
      verificationBySubject.set(event.survivor, { account: link.account, receipt: link.receipt_id });
  }
  for (const envelope of envelopes) {
    for (const event of envelope.events) {
      if (event.type === LINK_KEYS_CHANGED) {
        const data = event.data as LinkKeysChanged;
        if (data.direction === 'holder') await reemitHolderKeys(pool, data);
        else await reemitTargetKeys(pool, data);
      } else if (event.type === LINKS_VISIBILITY_CHANGED) {
        await applyVisibilityPage(pool, event.data as LinksVisibilityChanged);
      }
    }
  }
  const moved = new Set<string>();
  for (const envelope of envelopes) {
    for (const event of envelope.events) {
      if (event.type === SUBJECT_MERGED) {
        const data = event.data as { id: string; survivor: string };
        if (moved.has(data.id)) continue;
        const verification = verificationBySubject.get(data.survivor);
        if (await moveMergePage(pool, data.id, data.survivor, undefined, verification)) moved.add(data.id);
      } else if (event.type === LINKS_MOVING) {
        const data = event.data as {
          id: string;
          survivor: string;
          cursor: string[];
          verification?: { account: string; receipt: string };
        };
        if (moved.has(data.id)) continue;
        if (await moveMergePage(pool, data.id, data.survivor, data.cursor, data.verification)) moved.add(data.id);
      }
    }
  }
}

export function linkProjection(pool: Pool): Relay {
  return {
    consumer: LINKS_CONSUMER,
    run: (partition) =>
      projectBatch(pool, {
        consumer: LINKS_CONSUMER,
        partition,
        apply: (envelopes) => applyLinkBatch(pool, envelopes),
      }),
  };
}

export type SubjectLink = {
  subject: string;
  property: string;
  statement: string;
  type?: string;
  label?: string;
  summary?: SubjectSummary | null;
};
export type SubjectLinksPage = {
  links: SubjectLink[];
  count?: { value: number; exact: boolean };
  freshness: { consistency: 'eventual'; target_seconds: 10; caught_up: boolean };
  next: string | null;
  component: { partition: number; epoch: number; position: bigint };
};

function validAfter(after: CursorKey[], property: string | null): boolean {
  if (after.length !== 3) return false;
  const [cursorProperty, source, statement] = after;
  if (typeof cursorProperty !== 'string' || (property === null && cursorProperty.length < 1)) return false;
  if (typeof source !== 'string' || typeof statement !== 'string') return false;
  if (!UUID.test(source) || !UUID.test(statement)) return false;
  return true;
}

export async function listSubjectLinks(
  pool: Pool,
  ring: KeyRing,
  options: {
    subject: string;
    context?: string;
    property: string | null;
    limit: number;
    filter?: string;
    type?: string;
    language?: string;
    languages?: readonly string[];
    includeLabels?: boolean;
    authorizeSummary?: SummaryDependencies['authorize'];
    release?: Release;
    cursor?: string;
    authorize: (client: PoolClient) => Promise<boolean>;
    prepareAuthorization?: () => Promise<AccessCheck>;
    deadline?: number;
    seen: readonly SessionComponent[];
    caughtUp?: boolean;
  },
): Promise<SubjectLinksPage> {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
    throw new RangeError('Invalid links page limit');
  const context = options.context ?? GLOBAL_CONTEXT;
  if (context !== GLOBAL_CONTEXT && !(await contextSnapshot(pool, context))) throw new SubjectNotFoundError();
  const languages = options.languages ?? languageRanges(null, options.language);
  const binding = {
    operation: 'subject.links',
    parameters: {
      subject: options.subject,
      ...(context === GLOBAL_CONTEXT ? {} : { context }),
      property: options.property,
      filter: options.filter ?? null,
      type: options.type ?? null,
      language: languages.join(',') || null,
    },
  };
  const release = options.type ? (options.release ?? (await activeRelease(pool))?.release) : undefined;
  const matches = (type: string) => !options.type || (!!release && matchesTarget(release, type, [options.type]));
  let cursor: { epoch: number; after: CursorKey[] } | null = null;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, options.cursor);
    if (!decoded.ok) throw new PageCursorError(decoded.reason);
    if (!validAfter(decoded.after, options.property)) throw new PageCursorError('invalid');
    cursor = decoded;
  }
  const deadline = options.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  let caughtUp = options.caughtUp ?? (await waitForSubjectLinks(pool, options.seen, options.subject, deadline));
  const readPage = async (refreshAuthorization = true) => {
    if (refreshAuthorization) await refreshStatementReaderAuthorization();
    const authorize =
      refreshAuthorization && options.prepareAuthorization ? await options.prepareAuthorization() : options.authorize;
    return withReadTransaction<{
      page: SubjectLinksPage;
      scannedMembers: string[];
    }>(pool, async (client) => {
      const partition = await readPartition(client, partitionOf(route));
      const state = (await readVisibility.run(client, { route, subject_id: options.subject })) as {
        visibility: string;
      } | null;
      if (!partition || state?.visibility !== 'visible' || !(await authorize(client))) throw new SubjectNotFoundError();
      const redirect = await redirectOf(client, options.subject);
      if (redirect) throw new SubjectRedirectError(options.subject, redirect);
      await client.query('SET LOCAL enable_seqscan = off');
      if (cursor && cursor.epoch !== partition.epoch) throw new PageCursorError('stale');
      const afterSource = typeof cursor?.after[1] === 'string' ? cursor.after[1] : NIL_UUID;
      const afterStatement = typeof cursor?.after[2] === 'string' ? cursor.after[2] : NIL_UUID;
      let rows =
        options.property === null
          ? await listInboundLinks.run(client, {
              context_id: context,
              route,
              subject_id: options.subject,
              after_property: typeof cursor?.after[0] === 'string' ? cursor.after[0] : '',
              after_source: afterSource,
              after_statement: afterStatement,
              page_limit: options.limit + 1,
            })
          : await listInboundLinksByProperty.run(client, {
              context_id: context,
              route,
              subject_id: options.subject,
              property: options.property,
              filter_value: options.filter ?? NIL_UUID,
              after_order: typeof cursor?.after[0] === 'string' ? cursor.after[0] : '',
              after_source: afterSource,
              after_statement: afterStatement,
              page_limit: (options.type ? 4 * options.limit : options.limit) + 1,
            });
      const privatePage = await privateLinks(client, {
        subject: options.subject,
        inbound: true,
        property: options.property,
        crossProperty: options.property === null,
        after: cursor?.after,
        limit: (options.type ? 4 * options.limit : options.limit) + 1,
      });
      const privateRows = privatePage.entries.map((row) => ({
        subject: row.subject_id,
        property: row.property,
        statement: row.candidate_id,
        type: row.source_type,
        order_key: row.order_key,
      }));
      rows = [...rows, ...privateRows]
        .sort((a, b) => {
          const left = options.property === null ? a.property : 'order_key' in a ? String(a.order_key) : '';
          const right = options.property === null ? b.property : 'order_key' in b ? String(b.order_key) : '';
          return left < right
            ? -1
            : left > right
              ? 1
              : a.subject < b.subject
                ? -1
                : a.subject > b.subject
                  ? 1
                  : a.statement.localeCompare(b.statement);
        })
        .slice(0, (options.type ? 4 * options.limit : options.limit) + 1);
      const scanLimit = options.type ? 4 * options.limit : options.limit;
      const scanned = rows.slice(0, scanLimit);
      const scannedMembers = [...new Set(scanned.map((row) => row.subject))];
      const links: Omit<SubjectLink, 'label'>[] = [];
      let examined = 0;
      for (const row of rows.slice(0, scanLimit)) {
        examined++;
        if (matches(row.type))
          links.push({ subject: row.subject, property: row.property, statement: row.statement, type: row.type });
        if (links.length === options.limit) break;
      }
      const last = rows[examined - 1];
      let count: { value: number; exact: boolean } | undefined;
      if (options.property !== null) {
        const total = await readInboundLinkCount.run(client, {
          context_id: context,
          route,
          subject_id: options.subject,
          property: options.property,
          filter_value: options.filter ?? NIL_UUID,
        });
        const value = Number(total?.value ?? 0) + privatePage.total;
        if (!options.type) count = { value, exact: true };
        else {
          const sample = await countInboundLinkTypes.run(client, {
            context_id: context,
            route,
            subject_id: options.subject,
            property: options.property,
            filter_value: options.filter ?? NIL_UUID,
          });
          count = {
            value:
              sample.filter((row) => matches(row.type)).length +
              privatePage.entries.filter((row) => matches(row.source_type)).length,
            exact: value <= 1000 && privatePage.total <= privatePage.entries.length,
          };
        }
      }
      return {
        page: {
          links,
          ...(count ? { count } : {}),
          freshness: {
            consistency: 'eventual',
            target_seconds: FRESHNESS_TARGET_SECONDS,
            caught_up: caughtUp,
          },
          next:
            rows.length > examined && last
              ? encodeCursor(ring, binding, {
                  epoch: partition.epoch,
                  after: [
                    options.property === null ? last.property : 'order_key' in last ? String(last.order_key) : '',
                    last.subject,
                    last.statement,
                  ],
                })
              : null,
          component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
        },
        scannedMembers,
      };
    });
  };
  let snapshot = await readPage(options.caughtUp === undefined);
  let pendingMembers = await pendingMergeSources(pool, snapshot.scannedMembers);
  while (pendingMembers.length) {
    if (Date.now() >= deadline) {
      caughtUp = false;
      snapshot.page.freshness.caught_up = false;
      break;
    }
    caughtUp = await waitForSubjectLinks(pool, options.seen, options.subject, deadline, pendingMembers);
    // Even an unready wait can outlive evidence or a grant. Recheck current
    // source authority before returning either a fresh or an eventual page.
    snapshot = await readPage();
    if (!caughtUp) {
      snapshot.page.freshness.caught_up = false;
      break;
    }
    pendingMembers = await pendingMergeSources(pool, snapshot.scannedMembers);
  }
  const page = snapshot.page;
  const includeLabels = options.includeLabels ?? options.property !== null;
  const summaryRelease = includeLabels ? (options.release ?? (await activeRelease(pool))?.release) : undefined;
  const summaries = summaryRelease
    ? await readSubjectSummaries(
        {
          client: { query: pool.query.bind(pool) },
          pool,
          release: summaryRelease,
          authorize: options.authorizeSummary ?? (async () => false),
        },
        page.links.map((link) => link.subject),
        { languages },
      )
    : new Map<string, SubjectSummary | null>();
  requireAccessDeadline(deadline);
  return {
    ...page,
    links: page.links.flatMap((link) => {
      if (!includeLabels) return [{ subject: link.subject, property: link.property, statement: link.statement }];
      const summary = summaries.get(link.subject) ?? null;
      if (options.authorizeSummary && !summary) return [];
      return [
        {
          ...link,
          type: summary?.type ?? link.type,
          label: summary?.label?.value ?? '',
          summary,
        },
      ];
    }),
  };
}

export type SubjectRelation = {
  statement: Statement;
  target: string | null;
  external: string | null;
  type?: string;
  label?: string;
  summary?: SubjectSummary | null;
};
export type SubjectRelationsPage = {
  relations: SubjectRelation[];
  count: { value: number; exact: boolean };
  freshness: { consistency: 'eventual'; target_seconds: 10; caught_up: boolean };
  next: string | null;
  component: { partition: number; epoch: number; position: bigint };
};

function validRelationAfter(after: CursorKey[]): boolean {
  return (
    after.length === 3 &&
    typeof after[0] === 'string' &&
    typeof after[1] === 'string' &&
    typeof after[2] === 'string' &&
    UUID.test(after[1]) &&
    UUID.test(after[2])
  );
}

/** Forward relation page over the holder-local projection, with slot views filled only for this page. */
export async function listSubjectRelations(
  pool: Pool,
  ring: KeyRing,
  options: {
    subject: string;
    property: string;
    context?: string;
    limit: number;
    filter?: string;
    type?: string;
    language?: string;
    languages?: readonly string[];
    cursor?: string;
    release: Release;
    authorize: (client: PoolClient) => Promise<boolean>;
    prepareAuthorization?: () => Promise<AccessCheck>;
    deadline?: number;
    authorizeSummary?: SummaryDependencies['authorize'];
    seen: readonly SessionComponent[];
    caughtUp?: boolean;
  },
): Promise<SubjectRelationsPage> {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
    throw new RangeError('Invalid relation page limit');
  const context = options.context ?? GLOBAL_CONTEXT;
  const contextRecord = context === GLOBAL_CONTEXT ? null : await contextSnapshot(pool, context);
  if (context !== GLOBAL_CONTEXT && !contextRecord) throw new SubjectNotFoundError();
  const defaults = contextRecord?.defaults ?? {};
  const languages = options.languages ?? languageRanges(null, options.language);
  const binding = {
    operation: 'subject.relations',
    parameters: {
      subject: options.subject,
      property: options.property,
      context: options.context ?? NIL_UUID,
      filter: options.filter ?? null,
      type: options.type ?? null,
      language: languages.join(',') || null,
    },
  };
  let cursor: { epoch: number; after: CursorKey[] } | null = null;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, options.cursor);
    if (!decoded.ok) throw new PageCursorError(decoded.reason);
    if (!validRelationAfter(decoded.after)) throw new PageCursorError('invalid');
    cursor = decoded;
  }
  const deadline = options.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  const caughtUp = options.caughtUp ?? (await waitForSubjectLinks(pool, options.seen, options.subject, deadline));
  if (options.caughtUp === undefined) await refreshStatementReaderAuthorization();
  const authorize =
    options.caughtUp === undefined && options.prepareAuthorization
      ? await options.prepareAuthorization()
      : options.authorize;
  const page = await withReadTransaction<SubjectRelationsPage>(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    const state = (await readVisibility.run(client, { route, subject_id: options.subject })) as {
      visibility: string;
    } | null;
    if (!partition || state?.visibility !== 'visible' || !(await authorize(client))) throw new SubjectNotFoundError();
    const redirect = await redirectOf(client, options.subject);
    if (redirect) throw new SubjectRedirectError(options.subject, redirect);
    await client.query('SET LOCAL enable_seqscan = off');
    if (cursor && cursor.epoch !== partition.epoch) throw new PageCursorError('stale');
    const scanLimit = options.type ? 4 * options.limit : options.limit;
    let rows = (await listOutboundLinksByProperty.run(client, {
      context_id: context,
      route,
      subject_id: options.subject,
      property: options.property,
      filter_value: options.filter ?? NIL_UUID,
      after_order: typeof cursor?.after[0] === 'string' ? cursor.after[0] : '',
      after_target: typeof cursor?.after[1] === 'string' ? cursor.after[1] : NIL_UUID,
      after_statement: typeof cursor?.after[2] === 'string' ? cursor.after[2] : NIL_UUID,
      page_limit: scanLimit + 1,
    })) as {
      statement: string;
      slot: string;
      target: string | null;
      type: string;
      external: string | null;
      value: 'value' | 'somevalue' | 'novalue';
      order_key: string;
    }[];
    const privatePage = await privateLinks(client, {
      subject: options.subject,
      property: options.property,
      after: cursor?.after,
      limit: scanLimit + 1,
    });
    const privateRows = privatePage.entries.map((row) => ({
      statement: row.candidate_id,
      slot: row.slot_id,
      target: row.target_id,
      type: row.target_type,
      external: null,
      value: 'value' as const,
      order_key: row.order_key,
    }));
    rows = [...rows, ...privateRows]
      .sort((a, b) =>
        a.order_key < b.order_key
          ? -1
          : a.order_key > b.order_key
            ? 1
            : (a.target ?? NIL_UUID) < (b.target ?? NIL_UUID)
              ? -1
              : (a.target ?? NIL_UUID) > (b.target ?? NIL_UUID)
                ? 1
                : a.statement.localeCompare(b.statement),
      )
      .slice(0, scanLimit + 1);
    const visibleRows = rows.slice(0, scanLimit);
    const selected: typeof visibleRows = [];
    let examined = 0;
    for (const row of visibleRows) {
      examined++;
      if (!options.type || (row.type !== '' && matchesTarget(options.release, row.type, [options.type])))
        selected.push(row);
      if (selected.length === options.limit) break;
    }
    const total = await readOutboundLinkCount.run(client, {
      context_id: context,
      route,
      subject_id: options.subject,
      property: options.property,
      filter_value: options.filter ?? NIL_UUID,
    });
    const totalValue = Number(total?.value ?? 0) + privatePage.total;
    let count = { value: totalValue, exact: true };
    if (options.type) {
      const sample = (await countOutboundLinkTypes.run(client, {
        context_id: context,
        route,
        subject_id: options.subject,
        property: options.property,
        filter_value: options.filter ?? NIL_UUID,
      })) as { type: string }[];
      count = {
        value:
          sample.filter((row) => row.type !== '' && matchesTarget(options.release, row.type, [options.type!])).length +
          privatePage.entries.filter((row) => matchesTarget(options.release, row.target_type, [options.type!])).length,
        exact: totalValue <= 1000 && privatePage.total <= privatePage.entries.length,
      };
    }
    const relations: SubjectRelation[] = [];
    const holder = (await readVisibility.run(client, { route, subject_id: options.subject })) as {
      type?: string;
    } | null;
    for (const row of selected) {
      const view = await slotView(client, options.subject, options.property, context, defaults, row.slot);
      const fact = view.facts.find((entry) => entry.statement_id === row.statement);
      if (!fact) continue;
      const dataTypes = factDataTypes(options.release, [fact]);
      const statement = resolveItem(options.subject, [fact], holder?.type ?? '', dataTypes, {
        revision: fact.fact_revision ?? 1,
        release: fact.fact_release ?? '',
        context,
      }).statements[options.property]?.[0];
      if (!statement) continue;
      relations.push({
        statement,
        target: row.target,
        external: row.external,
        ...(row.target === null ? {} : { type: row.type }),
      });
    }
    const last = visibleRows[examined - 1];
    return {
      relations,
      count,
      freshness: {
        consistency: 'eventual',
        target_seconds: FRESHNESS_TARGET_SECONDS,
        caught_up: caughtUp,
      },
      next:
        rows.length > examined && last
          ? encodeCursor(ring, binding, {
              epoch: partition.epoch,
              after: [last.order_key, last.target ?? NIL_UUID, last.statement],
            })
          : null,
      component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
    };
  });
  const summaries = await readSubjectSummaries(
    {
      client: { query: pool.query.bind(pool) },
      pool,
      release: options.release,
      authorize: options.authorizeSummary ?? (async () => false),
    },
    page.relations.flatMap((entry) => (entry.target ? [entry.target] : [])),
    { languages },
  );
  requireAccessDeadline(deadline);
  const relations: SubjectRelation[] = [];
  for (const entry of page.relations) {
    if (!entry.target) {
      relations.push({ ...entry, summary: null });
      continue;
    }
    const summary = summaries.get(entry.target) ?? null;
    if (options.authorizeSummary && !summary) continue;
    const type = summary?.type ?? entry.type;
    relations.push({
      ...entry,
      ...(type ? { type } : {}),
      label: summary?.label?.value ?? '',
      summary,
    });
  }
  return { ...page, relations };
}
