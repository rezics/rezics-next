import type { Pool } from 'pg';
import { runCommand } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { LINKS_MOVING, LINKS_PROJECTED } from './events.ts';
import { redirectOf } from './merges.ts';
import upsertInboundLinks from './upsert-inbound-links.sql';

type Move = { phase: 'links' | 'members' | 'done'; cursor: string[] };
type Link = {
  property: string;
  source_subject_id: string;
  statement_id: string;
  source_revision: number;
  present: boolean;
};
const projected = (id: string) => ({ type: LINKS_PROJECTED, data: { subjects: [id] } });
const NIL = '00000000-0000-0000-0000-000000000000';
const moving = (id: string, survivor: string, state: Move) => ({
  type: LINKS_MOVING,
  subject: survivor,
  data: { id, survivor, cursor: [state.phase, ...state.cursor] },
});

/** Register before repointing: a concurrent merge must find the member in its own partition. */
async function register(
  pool: Pool,
  id: string,
  survivor: string,
  initial: Move = { phase: 'links', cursor: [] },
): Promise<{ survivor: string; state: Move }> {
  for (;;) {
    const route = routeOf(survivor)!;
    const result = await runCommand<{ redirect: string | null; state: Move | null }>(
      pool,
      { partition: partitionOf(route) },
      async (tx) => {
        const redirect = await redirectOf(tx, survivor);
        if (redirect) {
          const previous = (
            await tx.query<Move>(
              'SELECT phase, cursor FROM semantic.merge_member WHERE route = $1 AND subject_id = $2 AND member_id = $3',
              [route, survivor, id],
            )
          ).rows[0];
          return { value: { redirect, state: previous ?? initial }, events: [projected(survivor)] };
        }
        const inserted = await tx.query(
          'INSERT INTO semantic.merge_member (route, subject_id, member_id, phase, cursor) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING member_id',
          [route, survivor, id, initial.phase, JSON.stringify(initial.cursor)],
        );
        const state = (
          await tx.query<Move>(
            'SELECT phase, cursor FROM semantic.merge_member WHERE route = $1 AND subject_id = $2 AND member_id = $3',
            [route, survivor, id],
          )
        ).rows[0]!;
        return {
          value: { redirect: null, state },
          events: inserted.rowCount && state.phase !== 'done' ? [moving(id, survivor, state)] : [projected(survivor)],
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
        const current = await tx.query<{ sequence: number; target: string }>(
          'SELECT sequence, target::text FROM semantic.redirect WHERE route = $1 AND subject_id = $2 ORDER BY sequence DESC LIMIT 1',
          [routeOf(id), id],
        );
        const last = current.rows[0];
        if (last && last.target < survivor) return { value: last.target, events: [projected(survivor)] };
        if (last && last.target !== survivor) {
          await tx.query(
            'INSERT INTO semantic.redirect (route, subject_id, sequence, target, recorded_transaction_id) VALUES ($1, $2, $3, $4, $5)',
            [routeOf(id), id, last.sequence + 1, survivor, transactionId],
          );
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
): Promise<boolean> {
  const registered = await register(pool, id, target);
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
        await tx.query<Link>(
          `SELECT property, source_subject_id::text, statement_id::text, source_revision, present
         FROM semantic.inbound_link WHERE route = $1 AND subject_id = $2 AND present
         AND (property, source_subject_id, statement_id) > ($3, $4::uuid, $5::uuid)
         ORDER BY property, source_subject_id, statement_id LIMIT 100`,
          [sourceRoute, id, state.cursor[0] ?? '', state.cursor[1] ?? NIL, state.cursor[2] ?? NIL],
        )
      ).rows;
      const last = links.at(-1);
      if (links.length === 100 && last)
        next = { phase: 'links', cursor: [last.property, last.source_subject_id, last.statement_id] };
      else {
        const member = await tx.query(
          'SELECT member_id FROM semantic.merge_member WHERE route = $1 AND subject_id = $2 ORDER BY member_id LIMIT 1',
          [sourceRoute, id],
        );
        next = { phase: member.rowCount ? 'members' : 'done', cursor: [] };
      }
    } else {
      members = (
        await tx.query<{ member_id: string } & Move>(
          'SELECT member_id::text, phase, cursor FROM semantic.merge_member WHERE route = $1 AND subject_id = $2 AND member_id > $3::uuid ORDER BY member_id LIMIT 100',
          [sourceRoute, id, state.cursor[0] ?? NIL],
        )
      ).rows;
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
    const current = (
      await tx.query<Move>(
        'SELECT phase, cursor FROM semantic.merge_member WHERE route = $1 AND subject_id = $2 AND member_id = $3',
        [route, survivor, id],
      )
    ).rows[0]!;
    if (JSON.stringify(current) !== JSON.stringify(state)) return { value: null, events: [projected(survivor)] };
    if (page.value.links.length)
      await upsertInboundLinks.run(tx, {
        transaction_id: transactionId,
        changes: page.value.links.map((link) => ({ ...link, route, subject_id: survivor })),
      });
    await tx.query(
      'UPDATE semantic.merge_member SET phase = $4, cursor = $5 WHERE route = $1 AND subject_id = $2 AND member_id = $3',
      [route, survivor, id, page.value.next.phase, JSON.stringify(page.value.next.cursor)],
    );
    return {
      value: null,
      events: page.value.next.phase === 'done' ? [projected(survivor)] : [moving(id, survivor, page.value.next)],
    };
  });
  if (applied.value) return moveMergePage(pool, id, applied.value);
  return true;
}
