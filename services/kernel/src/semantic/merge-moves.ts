import type { Pool, PoolClient } from 'pg';
import { runCommand } from '../command/command.ts';
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

type Move = { phase: 'links' | 'members' | 'done'; cursor: string[] };
type Verification = { account: string; receipt: string };
type Link = {
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
        })
      ).map((link) => ({ ...link, source_security_revision: Number(link.source_security_revision) }));
      const last = links.at(-1);
      if (links.length === 100 && last)
        next = {
          phase: 'links',
          cursor: [last.property, last.source_subject_id, last.statement_id, last.filter_value],
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
    return { value: { links, members, next }, events: [projected(survivor)] };
  });
  // Repoint at most this page of members. Their pending link moves get separate continuations.
  for (const member of page.value.members)
    await register(pool, member.member_id, survivor, { phase: member.phase, cursor: member.cursor });
  const route = routeOf(survivor)!;
  const applied = await runCommand(pool, { partition: partitionOf(route) }, async (tx, { transactionId }) => {
    const redirect = await redirectOf(tx, survivor);
    if (redirect) return { value: redirect, events: [projected(survivor)] };
    const current = (await readMember.run(tx, { route, subject_id: survivor, member_id: id })) as Move;
    if (JSON.stringify(current) !== JSON.stringify(state)) return { value: null, events: [projected(survivor)] };
    if (page.value.links.length)
      await upsertInboundLinks.run(tx, {
        route,
        transaction_id: transactionId,
        changes: page.value.links.map((link) => ({ ...link, subject_id: survivor })),
      });
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
          statement_id: link.statement_id,
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
