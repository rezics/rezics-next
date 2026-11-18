import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient, QueryResultRow } from 'pg';
import { MAX_PAGE_COST } from '@rezics/composition';
import { partitionOf, routeOf } from '../route/route.ts';
import type { PrivacyReductionObservation } from './public-filter-source-contract.ts';
import type { PublicFilterSearchBindingPort, SourceBindingCustodyExecution } from './source-binding-port.ts';
import { PUBLIC_FILTER_CATALOGUE_TEXT_KEYS } from './public-filter-coverage-pending.ts';
import type {
  PopulationBinding,
  PopulationCost,
  PopulationProof,
  PopulationRequest,
} from './public-filter-coverage-population.ts';

const bindings = readFileSync(new URL('./public-filter-book-bindings.sql', import.meta.url), 'utf8');
const coverage = readFileSync(new URL('./public-filter-book-population.sql', import.meta.url), 'utf8');
const ownRows = readFileSync(new URL('./public-filter-book-own-rows.sql', import.meta.url), 'utf8');

const retainStarts = `WITH starts AS (
  INSERT INTO semantic.public_filter_population_start(partition_no,id,registration,observation,bootstrap,
    read_definition,consumer,covered_generation,start_generation,owner_epoch,deadline)
  SELECT 0,i.id,i.registration,i.observation,i.bootstrap,i.read_definition,i.consumer,i.covered_generation,$2,i.owner_epoch,i.deadline
  FROM jsonb_to_recordset($1::jsonb) i(id uuid,registration text,observation text,bootstrap uuid,read_definition uuid,
    consumer text,covered_generation bigint,owner_epoch integer,deadline bigint) RETURNING id)
  UPDATE search.public_filter_coverage_page pg SET state='open',revision=revision+1 FROM starts
  WHERE (pg.partition_no,pg.id)=(0,starts.id) AND pg.state='planned' RETURNING pg.id`;
const finishPages = `UPDATE search.public_filter_coverage_page SET state='finished',revision=revision+1
  WHERE partition_no=0 AND id=ANY($1::uuid[]) AND state='sealed' RETURNING id`;

type BookBinding = PopulationBinding & { coverage_publication: string; page_id: string; page_ceiling: number };
type Proof = PopulationProof & {
  coverage_registration: string;
  coverage_bootstrap: string;
  generation: string;
};

function scope(row: BookBinding, request: PopulationRequest) {
  return [
    request.queried.consumer.physicalTarget,
    request.queried.consumer.incarnation,
    row.coverage_publication,
    row.source_id,
    row.configuration,
    row.release_digest,
    row.owner_epoch,
    row.covered_generation,
    row.start_generation,
    row.coverage_keys,
    row.book_withdrawals,
  ];
}

/** The exact windows and the native publication proof are read in the same fresh
 * snapshot as the distinct home and Subject controls. Neither snapshot spans engine I/O. */
export async function readBookRole(
  client: PoolClient,
  requests: PopulationRequest[],
  members: { slot: number; start_id: string | null; deadline: number }[],
  costs: PopulationCost[],
  routeDigest: string,
  deadline: number,
  search: PublicFilterSearchBindingPort,
  valid: (row: BookBinding, request: PopulationRequest) => boolean,
): Promise<PrivacyReductionObservation[]> {
  const final = requests[0]!.start !== null;
  const refuse = (): never => {
    throw new TypeError('Incomplete native Book population');
  };
  const indices = members.map((m) => m.slot);
  // Charge the complete wire envelope once. Spread indivisible shared points
  // over the participating reads, including seeks which return no row.
  let next = 0;
  function charge(slots: number[], points: number, keys: number) {
    for (let i = 0; i < points; i++) {
      const cost = costs[slots[(next + i) % slots.length]!]!;
      cost.dependencyPoints++;
      cost.rows++;
    }
    for (let i = 0; i < keys; i++) costs[slots[(next + i) % slots.length]!]!.inputKeys++;
    next += points;
  }
  function bytes(total: number, payloads: readonly { slot: number; size: number }[] = []) {
    for (const { slot, size } of payloads) {
      costs[slot]!.bytes += size;
      total -= size;
    }
    for (const slot of indices) costs[slot]!.bytes += Math.floor((total + slot) / indices.length);
  }
  async function query<T extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
    input: readonly { slot: number; size: number }[] = [],
    boundRows = false,
  ) {
    costs[0]!.statements++;
    bytes(Buffer.byteLength(text) + Buffer.byteLength(search.encodeState(values)), input);
    const request = {
      text,
      values,
      query_timeout: Math.max(1, deadline - Date.now()),
    };
    const result = await client.query<T>(request);
    bytes(
      Buffer.byteLength(search.encodeState(result.rows)),
      boundRows ? result.rows.map((row) => ({ slot: row.slot, size: Buffer.byteLength(search.encodeState(row)) })) : [],
    );
    return result.rows;
  }

  await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    // These reads have a bound on examined rows even in a small catalogue where
    // PostgreSQL would otherwise scan historical, inactive pending rows.
    await query('SET LOCAL enable_seqscan = off');
    // Six exact child controls. FINAL also resolves its retained start and reads
    // each execution once through the page index, including the sealed tail.
    for (const slot of indices) charge([slot], final ? 7 : 6, final ? 17 : 15);
    const rows = await query<BookBinding>(
      bindings,
      [JSON.stringify(members), Date.now()],
      members.map((m) => ({ slot: m.slot, size: Buffer.byteLength(JSON.stringify(m)) })),
      true,
    );
    if (rows.length !== members.length || rows.some((r, i) => r.slot !== i)) refuse();
    const first = rows[0]!;
    const sharedScope = scope(first, requests[0]!);
    const owners = new Map<string, number[]>();
    const blocked = new Set<number>();
    let slots = 0;
    for (const row of rows) {
      const request = requests[row.slot]!;
      const capture = search.decodeState<{ bookTypeList?: boolean; representation?: unknown }>(row.capture);
      if (
        capture.bookTypeList !== true ||
        'representation' in capture ||
        !isDeepStrictEqual(scope(row, request), sharedScope)
      )
        refuse();
      slots += Math.floor(row.page_ceiling / 6);
      charge([row.slot], row.page_children.length, row.coverage_keys.length + 2 * row.page_children.length);
      if (!valid(row, request)) {
        blocked.add(row.slot);
        continue;
      }
      for (const child of row.page_children) {
        const execution = search.decodeState<SourceBindingCustodyExecution>(child.execution);
        for (const { original, terminal } of execution.ownRows)
          for (const id of [original, terminal]) {
            const participants = owners.get(id);
            if (!participants) owners.set(id, [row.slot]);
            else if (participants.at(-1) !== row.slot) participants.push(row.slot);
          }
      }
    }
    if (slots > MAX_PAGE_COST) refuse();
    const withdrawals = Array.isArray(first.book_withdrawals) ? first.book_withdrawals.length : 0;
    // Live parent (including the child compatibility check and last baseline),
    // route/release, pending, fence, behind and changed, once for this snapshot.
    charge(indices, 32 + 3 * withdrawals, 64 + 4 * withdrawals);
    const { physicalTarget, incarnation } = requests[0]!.queried.consumer;
    const [proof] = await query<Proof>(
      coverage.replace('semantic.privacy-role', final ? 'semantic.privacy-final' : 'semantic.privacy-start'),
      [
        physicalTarget,
        incarnation,
        first.read_definition,
        first.coverage_publication,
        [...PUBLIC_FILTER_CATALOGUE_TEXT_KEYS],
        first.book_withdrawals === null ? null : JSON.stringify(first.book_withdrawals),
        first.covered_generation,
        first.start_generation,
        first.source_id,
        first.configuration,
        first.owner_epoch,
        first.coverage_keys,
        routeDigest,
        first.release_digest,
      ],
    );
    if (!proof) return refuse();
    charge(indices, 2 * proof.heads.length, 2 * proof.heads.length);
    const clean = !proof.pending && !proof.fenced && !proof.heads.length;
    if (clean && owners.size) {
      const ids = [...owners.keys()];
      const homes = new Map<number, Set<number>>();
      const partitions = ids.map((id) => {
        const route = routeOf(id);
        if (route === null) return refuse();
        const home = partitionOf(route);
        const participants = homes.get(home) ?? new Set<number>();
        for (const slot of owners.get(id)!) participants.add(slot);
        homes.set(home, participants);
        return home;
      });
      for (const participants of homes.values()) charge([...participants], 2, 5);
      for (const participants of owners.values()) charge(participants, 1, 2);
      // Limit the original per-plan footprint even when the same key was
      // charged to a sibling. Oversized windows cannot gain admission by sharing.
      for (const row of rows) {
        const keys = ids.filter((id) => owners.get(id)!.includes(row.slot));
        const homeCount = new Set(keys.map((id) => partitionOf(routeOf(id)!))).size;
        if (
          64 +
            4 * withdrawals +
            row.coverage_keys.length +
            5 * homeCount +
            (first.book_withdrawals === null ? 2 : 6) * keys.length >
          1000
        )
          refuse();
      }
      const checked = await query<{ id: string; admitted: boolean | null; check_birth: boolean | null }>(ownRows, [
        ids,
        partitions,
        proof.coverage_registration,
        proof.coverage_bootstrap,
        first.book_withdrawals === null ? null : JSON.stringify(first.book_withdrawals),
      ]);
      if (checked.length !== ids.length || new Set(checked.map((r) => r.id)).size !== ids.length) refuse();
      for (const result of checked) {
        const participants = owners.get(result.id);
        if (!participants) return refuse();
        if (result.check_birth) charge(participants, 2, 4);
        if (!result.admitted) for (const slot of participants) blocked.add(slot);
      }
    }
    const admitted = clean ? rows.filter((row) => !blocked.has(row.slot)) : [];
    const writes = admitted.filter((row) => !final || row.page_state === 'sealed');
    if (writes.length) {
      for (const row of writes) {
        // START inserts the immutable start (three FKs) and opens its page.
        charge([row.slot], final ? 1 : 5, final ? 2 : 10);
        costs[row.slot]!.resultWrites += final ? 1 : 2;
      }
      const changed = final
        ? await query<{ id: string }>(finishPages, [writes.map((row) => row.page_id)])
        : await query<{ id: string }>(retainStarts, [
            JSON.stringify(
              writes.map((row) => ({
                id: row.page_id,
                registration: row.registration,
                observation: row.observation,
                bootstrap: row.bootstrap,
                read_definition: row.read_definition,
                consumer: row.consumer,
                covered_generation: row.covered_generation,
                owner_epoch: row.owner_epoch,
                deadline: members[row.slot]!.deadline,
              })),
            ),
            proof.generation,
          ]);
      const committed = new Set(changed.map((r) => r.id));
      if (committed.size !== writes.length || writes.some((row) => !committed.has(row.page_id))) refuse();
    }
    await query('COMMIT');
    return rows.map((row, i) => {
      const cost = costs[i]!;
      if (
        proof.pending ||
        proof.fenced ||
        blocked.has(i) ||
        (!final && proof.heads.length) ||
        proof.heads.some(
          (h) =>
            h.current_epoch === null ||
            h.position === null ||
            h.population_fenced ||
            h.current_epoch !== h.source_epoch,
        ) ||
        cost.inputKeys > 1000 ||
        cost.bytes > 4 * 1024 * 1024
      )
        return { status: 'unready', reason: 'metadata_missing', cost };
      const heads = proof.heads.map((h) => ({
        phase: h.phase,
        head: { partition: h.source_home, epoch: h.current_epoch!, position: BigInt(h.position!) },
      }));
      return {
        status: 'observed',
        coverage: 'all_native_homes',
        routingComplete: true,
        start: { observation: 'population:' + row.page_id },
        unacknowledged: heads.filter((h) => h.phase === 'pending').map((h) => h.head),
        changed: heads.filter((h) => h.phase === 'changed').map((h) => h.head),
        blocking: heads.map((h) => ({ ...h, scope: 'filter_or_order' })),
        cost,
      };
    });
  } catch (error) {
    if (Date.now() < deadline) await query('ROLLBACK').catch(() => {});
    throw error;
  }
}
