import type { Pool, PoolClient } from 'pg';
import { runCommand, type CommandTransaction } from '../command/command.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { LINKS_MOVING, LINKS_PROJECTED } from './events.ts';
import { redirectOf } from './merges.ts';
import firstMember from './merge-moves-first-member.sql';
import insertMember from './merge-moves-insert-member.sql';
import insertRedirect from './merge-moves-insert-redirect.sql';
import pageLinks from './merge-moves-page-links.sql';
import pageMembers from './merge-moves-page-members.sql';
import readLastRedirect from './merge-moves-read-last-redirect.sql';
import readMember from './merge-moves-read-member.sql';
import updateMember from './merge-moves-update-member.sql';
import upsertInboundLinks from './upsert-inbound-links.sql';
import recordMovedAgentLinks from './account-agent-record-moved-links.sql';
import upsertOutboundLinks from './upsert-outbound-links.sql';
import pageOutbound from './list-outbound-merge.sql';
import readLatestRevision from './merges-read-latest-revision.sql';
import clearProjectionPending from './merge-clear-projection-pending.sql';
import pageMovedAgentLinks from './account-agent-reversal-page.sql';
import deleteMovedAgentLinks from './account-agent-reversal-delete-links.sql';

// Counter deltas observe Global writes before sparse Context rows in the same move.
async function upsertByContext<T extends { context_id?: string }>(
  tx: CommandTransaction,
  input: { route: number; transaction_id: string; changes: T[] },
  direction: 'inbound' | 'outbound',
) {
  const contexts = [...new Set(input.changes.map((row) => row.context_id ?? GLOBAL_CONTEXT))];
  contexts.sort((a, b) => (a === GLOBAL_CONTEXT ? -1 : b === GLOBAL_CONTEXT ? 1 : a.localeCompare(b)));
  for (const context of contexts) {
    const parameters = {
      ...input,
      changes: input.changes.filter((row) => (row.context_id ?? GLOBAL_CONTEXT) === context),
    };
    if (direction === 'inbound') await upsertInboundLinks.run(tx, parameters);
    else await upsertOutboundLinks.run(tx, parameters);
  }
}

type Verification = { account: string; receipt: string };
type Move = { phase: 'links' | 'outbound' | 'members' | 'done'; cursor: string[] };
type Link = {
  context_id: string;
  suppressed: boolean;
  property: string;
  source_subject_id: string;
  statement_id: string;
  source_revision: number;
  source_security_revision: number;
  present: boolean;
  source_type: string;
  order_key: string;
  filter_value: string;
};
type Outbound = {
  context_id: string;
  suppressed: boolean;
  property: string;
  statement: string;
  slot: string;
  target: string | null;
  filter_value: string;
  order_key: string;
  relation: boolean;
  source_type: string;
  source_order_key: string;
  outbound_order: 'position' | 'date' | 'name' | null;
  source_revision: number;
  source_security_revision: number;
  target_revision: number;
  target_type: string;
  external: string | null;
  value: 'value' | 'somevalue' | 'novalue';
};
type ReversalLink = {
  context_id: string;
  statement_id: string;
  property: string;
  source_subject_id: string;
  filter_value: string;
  source_revision: number | null;
  source_security_revision: string | null;
  present: boolean | null;
  source_type: string | null;
  order_key: string | null;
};
const projected = (id: string) => ({ type: LINKS_PROJECTED, data: { subjects: [id] } });
const NIL = '00000000-0000-0000-0000-000000000000';
const moving = (id: string, survivor: string, state: Move, verification?: Verification) => ({
  type: LINKS_MOVING,
  subject: survivor,
  data: { id, survivor, cursor: [state.phase, ...state.cursor], ...(verification ? { verification } : {}) },
});

/** Register before repointing: a concurrent merge must find the member in its own partition. */
async function register(
  pool: Pool,
  id: string,
  survivor: string,
  initial: Move = { phase: 'links', cursor: [] },
  verification?: Verification,
): Promise<{ survivor: string; state: Move }> {
  for (;;) {
    const route = routeOf(survivor)!;
    const result = await runCommand<{ redirect: string | null; state: Move | null }>(
      pool,
      { partition: partitionOf(route) },
      async (tx) => {
        const redirect = await redirectOf(tx, survivor);
        if (redirect) {
          const previous = (await readMember.run(tx, { route, subject_id: survivor, member_id: id })) as Move | null;
          return { value: { redirect, state: previous ?? initial }, events: [projected(survivor)] };
        }
        const inserted = await insertMember.run(tx, {
          route,
          subject_id: survivor,
          member_id: id,
          phase: initial.phase,
          cursor: initial.cursor,
        });
        const state = (await readMember.run(tx, { route, subject_id: survivor, member_id: id })) as Move;
        return {
          value: { redirect: null, state },
          events:
            inserted && state.phase !== 'done' ? [moving(id, survivor, state, verification)] : [projected(survivor)],
        };
      },
    );
    if (result.value.redirect) {
      survivor = result.value.redirect;
      initial = result.value.state!;
      continue;
    }
    const repointed = await runCommand(
      pool,
      { partition: partitionOf(routeOf(id)!) },
      async (tx, { transactionId }) => {
        const last = await readLastRedirect.run(tx, { route: routeOf(id)!, subject_id: id });
        if (last && last.target < survivor) return { value: last.target, events: [projected(survivor)] };
        if (last && last.target !== survivor) {
          await insertRedirect.run(tx, {
            route: routeOf(id)!,
            subject_id: id,
            sequence: last.sequence + 1,
            target: survivor,
            transaction_id: transactionId,
          });
        }
        return { value: survivor, events: [projected(survivor)] };
      },
    );
    if (repointed.value < survivor) {
      survivor = repointed.value;
      continue;
    }
    return { survivor, state: result.value.state! };
  }
}

/** One page per invocation. Continuations are durable events consumed in a later batch. */
export async function moveMergePage(
  pool: Pool,
  id: string,
  target: string,
  expected?: readonly string[],
  verification?: Verification,
): Promise<boolean> {
  const registered = await register(pool, id, target, undefined, verification);
  const { survivor, state } = registered;
  if (state.phase === 'done') return false;
  if (expected && survivor === target && JSON.stringify(expected) !== JSON.stringify([state.phase, ...state.cursor]))
    return false;
  const sourceRoute = routeOf(id)!;
  const page = await runCommand(pool, { partition: partitionOf(sourceRoute) }, async (tx) => {
    let links: Link[] = [];
    let outbound: Outbound[] = [];
    let members: ({ member_id: string } & Move)[] = [];
    let next: Move;
    if (state.phase === 'links') {
      links = (
        await pageLinks.run(tx, {
          route: sourceRoute,
          subject_id: id,
          after_property: state.cursor[0] ?? '',
          after_source: state.cursor[1] ?? NIL,
          after_statement: state.cursor[2] ?? NIL,
          after_filter: state.cursor[3] ?? NIL,
          after_context: state.cursor[4] ?? NIL,
        })
      ).map((link) => ({ ...link, source_security_revision: Number(link.source_security_revision) }));
      const last = links.at(-1);
      if (links.length === 100 && last)
        next = {
          phase: 'links',
          cursor: [last.property, last.source_subject_id, last.statement_id, last.filter_value, last.context_id],
        };
      else {
        next = { phase: 'outbound', cursor: [] };
      }
    } else if (state.phase === 'outbound') {
      const latest = await readLatestRevision.run(tx, { route: sourceRoute, subject_id: id });
      outbound = (
        await pageOutbound.run(tx, {
          route: sourceRoute,
          subject_id: id,
          after_property: state.cursor[0] ?? '',
          after_target: state.cursor[1] ?? NIL,
          after_statement: state.cursor[2] ?? NIL,
          after_filter: state.cursor[3] ?? NIL,
          after_context: state.cursor[4] ?? NIL,
        })
      ).map((row) => ({
        ...row,
        source_revision: Number(latest?.revision ?? row.source_revision),
        source_security_revision: Number(latest?.security_revision ?? row.source_security_revision),
        target_revision: Number(row.target_revision),
        target_type: String(row.target_type),
        relation: row.relation === true,
        target: typeof row.target === 'string' ? row.target : null,
        external: typeof row.external === 'string' ? row.external : null,
        value: row.value === 'novalue' || row.value === 'somevalue' ? row.value : 'value',
        outbound_order:
          row.outbound_order === 'position' || row.outbound_order === 'date' || row.outbound_order === 'name'
            ? row.outbound_order
            : null,
      })) as Outbound[];
      const last = outbound.at(-1);
      if (outbound.length === 100 && last)
        next = {
          phase: 'outbound',
          cursor: [last.property, last.target ?? NIL, last.statement, last.filter_value, last.context_id],
        };
      else {
        const member = await firstMember.run(tx, { route: sourceRoute, subject_id: id });
        next = { phase: member ? 'members' : 'done', cursor: [] };
      }
    } else {
      members = (await pageMembers.run(tx, {
        route: sourceRoute,
        subject_id: id,
        after_member: state.cursor[0] ?? NIL,
      })) as ({ member_id: string } & Move)[];
      next =
        members.length === 100
          ? { phase: 'members', cursor: [members.at(-1)!.member_id] }
          : { phase: 'done', cursor: [] };
    }
    return { value: { links, outbound, members, next }, events: [projected(survivor)] };
  });
  // Repoint at most this page of members. Their pending link moves get separate continuations.
  for (const member of page.value.members)
    await register(pool, member.member_id, survivor, { phase: member.phase, cursor: member.cursor });
  const route = routeOf(survivor)!;
  if (page.value.outbound.length) {
    const sourceRoute = routeOf(id)!;
    const revision = page.value.outbound[0]!.source_revision;
    const securityRevision = page.value.outbound[0]!.source_security_revision;
    await runCommand(pool, { partition: partitionOf(sourceRoute) }, async (tx, { transactionId }) => {
      await upsertByContext(
        tx,
        {
          route: sourceRoute,
          transaction_id: transactionId,
          changes: page.value.outbound.map((link) => ({
            subject_id: id,
            context_id: link.context_id,
            suppressed: link.suppressed,
            property: link.property,
            filter_value: link.filter_value,
            order_key: link.order_key,
            target_subject_id: link.target ?? NIL,
            statement_id: link.statement,
            slot_id: link.slot,
            relation: link.relation,
            source_type: link.source_type,
            source_order_key: link.source_order_key,
            outbound_order: link.outbound_order,
            source_revision: revision,
            source_security_revision: securityRevision,
            target_revision: link.target_revision,
            target_type: link.target_type,
            external: link.external,
            value: link.value,
            present: false,
          })),
        },
        'outbound',
      );
      return { value: null, events: [projected(id)] };
    });
    const targets = new Map<number, Outbound[]>();
    for (const link of page.value.outbound) {
      if (!link.target) continue;
      const targetRoute = routeOf(link.target)!;
      const partition = partitionOf(targetRoute);
      const group = targets.get(partition) ?? [];
      group.push(link);
      targets.set(partition, group);
    }
    for (const [partition, links] of targets) {
      const byRoute = new Map<number, Outbound[]>();
      for (const link of links) {
        const targetRoute = routeOf(link.target!)!;
        const group = byRoute.get(targetRoute) ?? [];
        group.push(link);
        byRoute.set(targetRoute, group);
      }
      await runCommand(pool, { partition }, async (tx, { transactionId }) => {
        for (const [targetRoute, routeLinks] of byRoute)
          await upsertByContext(
            tx,
            {
              route: targetRoute,
              transaction_id: transactionId,
              changes: routeLinks.map((link) => ({
                subject_id: link.target,
                context_id: link.context_id,
                suppressed: link.suppressed,
                property: link.property,
                source_subject_id: id,
                statement_id: link.statement,
                source_revision: revision,
                source_security_revision: securityRevision,
                present: false,
                source_type: link.source_type,
                order_key: link.source_order_key,
                filter_value: link.filter_value,
              })),
            },
            'inbound',
          );
        return { value: null, events: [projected(id)] };
      });
    }
  }
  if (state.phase === 'outbound' && page.value.next.phase !== 'outbound') {
    await runCommand(pool, { partition: partitionOf(sourceRoute) }, async (tx) => {
      await clearProjectionPending.run(tx, { route: sourceRoute, subject_id: id });
      return { value: null, events: [projected(id)] };
    });
  }
  const applied = await runCommand(pool, { partition: partitionOf(route) }, async (tx, { transactionId }) => {
    const redirect = await redirectOf(tx, survivor);
    if (redirect) return { value: redirect, events: [projected(survivor)] };
    const current = (await readMember.run(tx, { route, subject_id: survivor, member_id: id })) as Move;
    if (JSON.stringify(current) !== JSON.stringify(state)) return { value: null, events: [projected(survivor)] };
    if (page.value.links.length)
      await upsertByContext(
        tx,
        {
          route,
          transaction_id: transactionId,
          changes: page.value.links.map((link) => ({ ...link, subject_id: survivor })),
        },
        'inbound',
      );
    if (verification && page.value.links.length) {
      await recordMovedAgentLinks.run(tx as PoolClient, {
        route,
        receipt_id: verification.receipt,
        account_id: verification.account,
        survivor,
        moved_from: id,
        links: page.value.links.map((link) => ({
          receipt_id: verification.receipt,
          account_id: verification.account,
          context_id: link.context_id,
          statement_id: link.statement_id,
          property: link.property,
          source_subject_id: link.source_subject_id,
          filter_value: link.filter_value,
        })),
      });
    }
    await updateMember.run(tx, {
      route,
      subject_id: survivor,
      member_id: id,
      phase: page.value.next.phase,
      cursor: page.value.next.cursor,
    });
    return {
      value: null,
      events:
        page.value.next.phase === 'done'
          ? [projected(survivor)]
          : [moving(id, survivor, page.value.next, verification)],
    };
  });
  if (applied.value) return moveMergePage(pool, id, applied.value, undefined, verification);
  return true;
}

/** Move only the links recorded for this verification back to the account agent, a page at a time. */
export async function reverseAccountAgentLinks(
  pool: Pool,
  options: { account: string; receipt: string; survivor: string; movedFrom: string },
): Promise<void> {
  const route = routeOf(options.survivor);
  const nodeRoute = routeOf(options.movedFrom);
  if (route === null || nodeRoute === null) throw new TypeError('Account agent links must have routed subjects');
  let after: { property: string; source: string; statement: string; filter: string; context: string } = {
    property: '',
    source: NIL,
    statement: NIL,
    filter: NIL,
    context: NIL,
  };
  for (;;) {
    const page = await runCommand<ReversalLink[]>(pool, { partition: partitionOf(route) }, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const links = (await pageMovedAgentLinks.run(tx, {
        route,
        receipt_id: options.receipt,
        account_id: options.account,
        survivor: options.survivor,
        moved_from: options.movedFrom,
        after_property: after.property,
        after_source: after.source,
        after_statement: after.statement,
        after_filter: after.filter,
        after_context: after.context,
      })) as ReversalLink[];
      return { value: links, events: [projected(options.survivor)] };
    });
    if (!page.value.length) return;

    const restored = page.value.filter(
      (
        link,
      ): link is ReversalLink & {
        source_revision: number;
        source_security_revision: string;
        present: boolean;
        source_type: string;
        order_key: string;
      } => link.source_revision !== null && link.source_security_revision !== null && link.present !== null,
    );
    if (restored.length) {
      await runCommand(pool, { partition: partitionOf(nodeRoute) }, async (tx, { transactionId }) => {
        await tx.query('SET LOCAL enable_seqscan = off');
        await upsertByContext(
          tx,
          {
            route: nodeRoute,
            transaction_id: transactionId,
            changes: restored.map((link) => ({
              subject_id: options.movedFrom,
              context_id: link.context_id,
              property: link.property,
              source_subject_id: link.source_subject_id,
              statement_id: link.statement_id,
              source_revision: link.source_revision,
              source_security_revision: Number(link.source_security_revision),
              present: link.present,
              source_type: link.source_type ?? '',
              order_key: link.order_key ?? '',
              filter_value: link.filter_value,
            })),
          },
          'inbound',
        );
        return { value: null, events: [projected(options.movedFrom)] };
      });
    }
    await runCommand(pool, { partition: partitionOf(route) }, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const contexts = [...new Set(page.value.map((link) => link.context_id))];
      contexts.sort((a, b) =>
        a === GLOBAL_CONTEXT ? -1 : b === GLOBAL_CONTEXT ? 1 : a.localeCompare(b),
      );
      for (const context_id of contexts)
        await deleteMovedAgentLinks.run(tx, {
          route,
          receipt_id: options.receipt,
          account_id: options.account,
          survivor: options.survivor,
          moved_from: options.movedFrom,
          context_id,
          links: page.value
            .filter((link) => link.context_id === context_id)
            .map((link) => ({
              context_id: link.context_id,
              property: link.property,
              source_subject_id: link.source_subject_id,
              statement_id: link.statement_id,
              filter_value: link.filter_value,
            })),
        });
      return { value: null, events: [projected(options.survivor)] };
    });
    if (page.value.length < 100) return;
    const last = page.value.at(-1)!;
    after = {
      property: last.property,
      source: last.source_subject_id,
      statement: last.statement_id,
      filter: last.filter_value,
      context: last.context_id,
    };
  }
}
