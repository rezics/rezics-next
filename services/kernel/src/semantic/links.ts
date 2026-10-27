import { requireAccessDeadline } from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import type { Release } from '@rezics/definitions';
import { activeRelease } from './definitions.ts';
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
import { SubjectNotFoundError } from './candidates.ts';
import { moveMergePage } from './merge-moves.ts';
import { redirectOf, SubjectRedirectError } from './merges.ts';
import { accountAgentsForSubjects } from './agents.ts';
import { LINKS_MOVING, SUBJECT_MERGED, LINKS_CHANGED, LINKS_PROJECTED } from './events.ts';
import listInboundLinksByProperty from './list-inbound-links-by-property.sql';
import listInboundLinks from './list-inbound-links.sql';
import { PageCursorError } from './page.ts';
import readLinkCheckpoint from './read-link-checkpoint.sql';
import readPendingMember from './links-read-pending-member.sql';
import readVisibility from './read-visibility.sql';
import upsertInboundLinks from './upsert-inbound-links.sql';

export const LINKS_CONSUMER = 'semantic_links';
const FRESHNESS_TARGET_SECONDS = 10;
const FRESHNESS_WAIT_MS = 2_000;
const FRESHNESS_POLL_MS = 100;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type LinkChangeRow = {
  property: string;
  statement: string;
  target: string;
  present: boolean;
  source_type?: string;
  order_key?: string;
  filter_value?: string;
};
type LinksChanged = { subject: string; revision: number; security_revision: number; changes: LinkChangeRow[] };
type StoredChange = {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function covers(
  row: { epoch: number | null; position: string | number | bigint } | null,
  component: SessionComponent,
): boolean {
  if (!row || row.epoch === null) return false;
  const epoch = typeof row.epoch === 'number' ? row.epoch : Number(row.epoch);
  const position = typeof row.position === 'bigint' ? row.position : BigInt(row.position);
  return epoch > component.epoch || (epoch === component.epoch && position >= component.position);
}

async function linksCaughtUp(
  pool: Pool,
  seen: readonly SessionComponent[],
  subject: string,
  deadline = deadlineFor(FRESHNESS_WAIT_MS),
): Promise<boolean> {
  while (Date.now() < deadline) {
    const covered = await withConnection(pool, async (client) => {
      for (const component of seen) {
        const row = await readLinkCheckpoint.run(client, {
          partition_no: component.partition,
          consumer: LINKS_CONSUMER,
        });
        if (!covers(row, component)) return false;
      }
      const pending = await readPendingMember.run(client, { route: routeOf(subject)!, subject_id: subject });
      return pending === null;
    });
    if (covered) return true;
    if (deadline - Date.now() < FRESHNESS_POLL_MS) return false;
    await sleep(FRESHNESS_POLL_MS);
  }
  return false;
}

function newestChanges(envelopes: readonly Envelope[]): Map<number, StoredChange[]> {
  const newest = new Map<string, StoredChange>();
  for (const envelope of envelopes) {
    for (const event of envelope.events) {
      if (event.type !== LINKS_CHANGED) continue;
      const data = event.data as LinksChanged;
      const security = Number(data.security_revision);
      for (const change of data.changes) {
        const route = routeOf(change.target);
        if (route === null) continue;
        const key = `${route}\0${change.target}\0${change.property}\0${data.subject}\0${change.statement}\0${change.filter_value ?? NIL_UUID}`;
        const current = newest.get(key);
        if (current && olderChange(data.revision, security, envelope.position, current)) continue;
        newest.set(key, {
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

async function applyChanges(pool: Pool, changes: StoredChange[]): Promise<void> {
  const newest = new Map<string, StoredChange>();
  for (const change of changes) {
    const key = JSON.stringify([
      change.subjectId,
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
              subject_id: change.subjectId,
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

async function applyLinkBatch(pool: Pool, envelopes: readonly Envelope[]): Promise<void> {
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

export function waitForSubjectLinks(
  pool: Pool,
  seen: readonly SessionComponent[],
  subject: string,
  deadline: number,
): Promise<boolean> {
  const started = Date.now();
  // Leave at least half of the remaining request budget for authorization and the read.
  const waitUntil = Math.min(started + FRESHNESS_WAIT_MS, started + (deadline - started) / 2);
  return linksCaughtUp(pool, seen, subject, waitUntil);
}

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
    property: string | null;
    limit: number;
    filter?: string;
    type?: string;
    language?: string;
    includeLabels?: boolean;
    authorizeSummary?: SummaryDependencies['authorize'];
    release?: Release;
    cursor?: string;
    authorize: (client: PoolClient) => Promise<boolean>;
    seen: readonly SessionComponent[];
    caughtUp?: boolean;
  },
): Promise<SubjectLinksPage> {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
    throw new RangeError('Invalid links page limit');
  const binding = {
    operation: 'subject.links',
    parameters: {
      subject: options.subject,
      property: options.property,
      filter: options.filter ?? null,
      type: options.type ?? null,
      language: options.language ?? null,
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
  const caughtUp = options.caughtUp ?? (await linksCaughtUp(pool, options.seen, options.subject));
  const deadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  const page = await withReadTransaction<SubjectLinksPage>(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    const state = (await readVisibility.run(client, { route, subject_id: options.subject })) as {
      visibility: string;
    } | null;
    if (!partition || state?.visibility !== 'visible' || !(await options.authorize(client)))
      throw new SubjectNotFoundError();
    const redirect = await redirectOf(client, options.subject);
    if (redirect) throw new SubjectRedirectError(options.subject, redirect);
    if (cursor && cursor.epoch !== partition.epoch) throw new PageCursorError('stale');
    const afterSource = typeof cursor?.after[1] === 'string' ? cursor.after[1] : NIL_UUID;
    const afterStatement = typeof cursor?.after[2] === 'string' ? cursor.after[2] : NIL_UUID;
    const rows =
      options.property === null
        ? await listInboundLinks.run(client, {
            route,
            subject_id: options.subject,
            after_property: typeof cursor?.after[0] === 'string' ? cursor.after[0] : '',
            after_source: afterSource,
            after_statement: afterStatement,
            page_limit: options.limit + 1,
          })
        : await listInboundLinksByProperty.run(client, {
            route,
            subject_id: options.subject,
            property: options.property,
            filter_value: options.filter ?? NIL_UUID,
            after_order: typeof cursor?.after[0] === 'string' ? cursor.after[0] : '',
            after_source: afterSource,
            after_statement: afterStatement,
            page_limit: (options.type ? 4 * options.limit : options.limit) + 1,
          });
    const scanLimit = options.type ? 4 * options.limit : options.limit;
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
        route,
        subject_id: options.subject,
        property: options.property,
        filter_value: options.filter ?? NIL_UUID,
      });
      const value = Number(total?.value ?? 0);
      if (!options.type) count = { value, exact: true };
      else {
        const sample = await countInboundLinkTypes.run(client, {
          route,
          subject_id: options.subject,
          property: options.property,
          filter_value: options.filter ?? NIL_UUID,
        });
        count = { value: sample.filter((row) => matches(row.type)).length, exact: value <= 1000 };
      }
    }
    return {
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
    };
  });
  const includeLabels = options.includeLabels ?? options.property !== null;
  const summaryRelease = includeLabels ? (options.release ?? (await activeRelease(pool))?.release) : undefined;
  const summaries = summaryRelease
    ? await readSubjectSummaries(
        {
          client: { query: pool.query.bind(pool) },
          release: summaryRelease,
          authorize: options.authorizeSummary ?? (async () => false),
        },
        page.links.map((link) => link.subject),
        { languages: options.language ? [options.language] : [] },
      )
    : new Map<string, SubjectSummary | null>();
  requireAccessDeadline(deadline);
  return {
    ...page,
    links: page.links.map((link) =>
      includeLabels
        ? {
            ...link,
            label: summaries.get(link.subject)?.label?.value ?? '',
            summary: summaries.get(link.subject) ?? null,
          }
        : { subject: link.subject, property: link.property, statement: link.statement },
    ),
  };
}
