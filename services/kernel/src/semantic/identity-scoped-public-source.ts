import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { CommandTransaction } from '../command/command.ts';
import { currentCommand, runCommand } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import type {
  PublicFilterSourceFactory,
  PublicFilterReadContext,
  PublicFilterCost,
} from './public-filter-source-contract.ts';
import {
  createPublicFilterSourceBinding,
  type NativePublicSource,
  type PublicFilterSourceDefinition,
} from './public-filter-source-binding.ts';
import { createSubjectSourceKeyPages } from './subject-source-key-pages.ts';
import { publicFilterSource } from './public-filter-source.ts';
import { withReadTransaction } from './read.ts';
import { IdentityEpochStoreError, recordIdentityEpochNativeCommit } from './identity-adapters/index.ts';

declare const publicSourceCapture: unique symbol;
export type PublicIdentitySourceCapture = Readonly<{ [publicSourceCapture]: true }>;
export type PublicIdentitySourceCapturePage =
  | Readonly<{
      status: 'progress';
      captureId: string;
      frontier: string;
      originals: readonly string[];
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'complete';
      captureId: string;
      frontier: null;
      originals: readonly string[];
      capture: PublicIdentitySourceCapture;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed' | 'unready' | 'unavailable'; cost: PublicFilterCost }>;
export type PublicIdentitySourceCaptureProducer = Readonly<{
  capturePage(
    request: Readonly<{
      definition: PublicFilterSourceDefinition;
      frontier: string | null;
      inputLimit: number;
      context: PublicFilterReadContext;
    }>,
  ): Promise<PublicIdentitySourceCapturePage>;
}>;
export type CreatePublicIdentitySourceCapture = (
  config: Parameters<PublicFilterSourceFactory>[0],
) => PublicIdentitySourceCaptureProducer;
export type VerifyPublicIdentitySourceCapture = (
  tx: CommandTransaction,
  capture: PublicIdentitySourceCapture,
) => Promise<boolean>;

type Locator = { source: NativePublicSource; captureId: string; definition: string };
// Routing association only: every use independently resolves the retained native row and receipt.
const locators = new WeakMap<PublicIdentitySourceCapture, Locator>();
export function publicIdentityCaptureLocator(capture: PublicIdentitySourceCapture): Locator | null {
  return locators.get(capture) ?? null;
}
const digest = (v: object) => createHash('sha256').update(canonicalize(v)!).digest('hex');
const zero = (): PublicFilterCost => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});
const add = (a: PublicFilterCost, b: PublicFilterCost): PublicFilterCost =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v + b[k as keyof PublicFilterCost]])) as PublicFilterCost;
const unavailable = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Native public structural capture is unavailable');
type Head = {
  capture_id: string;
  source_id: string;
  source_epoch: number;
  configuration: string;
  read_definition: string;
  definition_digest: string;
  home: number;
  after_route: number | null;
  after_id: string | null;
  version: string;
  complete: boolean;
};
type RawPage = {
  ids: string[];
  after: { route: number; id: string } | null;
  complete: boolean;
  epoch: number;
  writer: string;
};

/** Background structural scan; it never evaluates a matcher or grants public read authority. */
export const createPublicIdentitySourceCapture: CreatePublicIdentitySourceCapture = (config) => {
  if (!config?.pool || !config.access || typeof config.clock !== 'function' || config.routeKey?.byteLength !== 32)
    throw new TypeError('Public capture requires the installed native Source configuration');
  const binding = createPublicFilterSourceBinding(config.pool, config.routeKey, config.access);
  const source = publicFilterSource(config);
  const keys = createSubjectSourceKeyPages(config.pool, config.routeKey, config.access);
  return {
    async capturePage(request) {
      if (!Number.isInteger(request.inputLimit) || request.inputLimit < 1 || request.inputLimit > 100)
        throw new RangeError('Public structural capture inputLimit must be 1..100');
      if (!Number.isFinite(request.context.deadline)) throw new TypeError('Public capture requires a deadline');
      let cost = zero();
      if (Date.now() >= request.context.deadline) return { status: 'unavailable', cost };
      // The registered compiler definition, including negative/population/order keys, is the authority.
      const resolved = await binding.resolve(
        { source, meaning: request.definition.meaning, capture: request.definition.capture },
        request.context,
      );
      cost = add(cost, resolved.cost);
      if (resolved.status !== 'resolved') return { status: resolved.status, cost };
      const definition = resolved.definition;
      if (digest(definition) !== digest(request.definition)) return { status: 'changed', cost };
      const d = digest(definition);
      let id: string;
      let expected: string | null = null;
      if (request.frontier === null) id = randomUUID();
      else {
        const match = /^([0-9a-f-]{36}):([1-9][0-9]*)$/.exec(request.frontier);
        if (!match) throw new TypeError('Invalid native public capture frontier');
        id = match[1]!;
        expected = match[2]!;
      }
      const partition = definition.source.partition;
      if (expected === null) {
        await runCommand(config.pool, { partition, deadline: request.context.deadline }, async (tx) => {
          await tx.query(
            `INSERT INTO semantic.identity_public_capture
            (partition_no,capture_id,source_id,source_epoch,configuration,read_definition,definition_digest)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              partition,
              id,
              definition.source.id,
              definition.source.epoch,
              definition.source.configuration,
              definition.readDefinition,
              d,
            ],
          );
          return { value: null, events: [] };
        });
        cost = { ...cost, frontierWrites: cost.frontierWrites + 1 };
      }
      const head = await withReadTransaction(
        config.pool,
        async (tx) =>
          (
            await tx.query<Head>(
              'SELECT * FROM semantic.identity_public_capture WHERE partition_no=$1 AND capture_id=$2',
              [partition, id],
            )
          ).rows[0],
      );
      if (!head || head.definition_digest !== d || (expected !== null && head.version !== expected))
        return { status: 'changed', cost };
      if (head.complete) {
        const capture = Object.freeze({}) as PublicIdentitySourceCapture;
        locators.set(capture, { source: definition.source, captureId: id, definition: d });
        return { status: 'complete', captureId: id, frontier: null, originals: [], capture, cost };
      }
      // Each native home advances separately. Never sweep homes in a request or hold two homes.
      const after = head.after_id === null ? null : { route: head.after_route!, id: head.after_id };
      const limit = Math.min(request.inputLimit, 8);
      const eligible = await keys.read({ partition: head.home, after, inputLimit: limit }, request.context);
      cost = add(cost, eligible.cost);
      if (eligible.status !== 'eligible') return { status: 'unready', cost };
      const page = await runCommand(
        config.pool,
        { partition: head.home, deadline: request.context.deadline },
        async (tx) => {
          const previous = (
            await tx.query<{ payload: RawPage }>(
              `SELECT payload FROM semantic.identity_public_capture_page
          WHERE partition_no=$1 AND capture_id=$2 AND page_version=$3`,
              [head.home, id, head.version],
            )
          ).rows[0];
          if (previous) return { value: previous.payload, events: [] };
          const owner = await readPartition(tx, head.home);
          if (!owner || owner.epoch !== eligible.epoch || owner.writeState !== 'active' || owner.movedTo !== null)
            throw unavailable();
          await tx.query(
            `INSERT INTO semantic.identity_public_writer(partition_no) VALUES($1) ON CONFLICT DO NOTHING`,
            [head.home],
          );
          const writer = (
            await tx.query<{ revision: string }>(
              'SELECT revision::text FROM semantic.identity_public_writer WHERE partition_no=$1 FOR UPDATE',
              [head.home],
            )
          ).rows[0]!;
          // Structural closure includes hidden, redirected, NOT/excluded and order-only originals.
          // Public eligibility pages alone intentionally do not certify this superset.
          const rows = (
            await tx.query<{ route: number; subject_id: string }>(
              `SELECT route,subject_id FROM semantic.subject
          WHERE route BETWEEN $1*16 AND $1*16+15 AND ($2::uuid IS NULL OR (route,subject_id)>($3,$2))
          ORDER BY route,subject_id LIMIT $4`,
              [head.home, head.after_id, head.after_route, limit],
            )
          ).rows;
          const last = rows.at(-1);
          // A lower-key writer restarts the bounded home scan. No changed head is silently called complete.
          const baseline = await tx.query<{ writer_revision: string }>(
            `SELECT writer_revision::text FROM semantic.identity_public_capture_home
          WHERE partition_no=$1 AND capture_id=$2 AND home=$1`,
            [head.home, id],
          );
          if (baseline.rows[0] && baseline.rows[0].writer_revision !== writer.revision) {
            const payload: RawPage = {
              ids: [],
              after: null,
              complete: false,
              epoch: owner.epoch,
              writer: writer.revision,
            };
            await tx.query(
              `UPDATE semantic.identity_public_capture_home SET writer_revision=$3,complete=false WHERE partition_no=$1 AND capture_id=$2 AND home=$1`,
              [head.home, id, writer.revision],
            );
            await tx.query(`INSERT INTO semantic.identity_public_capture_page VALUES($1,$2,$3,$4,$5)`, [
              head.home,
              id,
              head.version,
              payload,
              currentCommand(tx).transactionId,
            ]);
            recordIdentityEpochNativeCommit(tx, 'identity-public-capture');
            return { value: payload, events: [] };
          }
          await tx.query(
            `INSERT INTO semantic.identity_public_capture_home(partition_no,capture_id,home,owner_epoch,writer_revision,complete)
          VALUES($1,$2,$1,$3,$4,$5) ON CONFLICT(partition_no,capture_id,home) DO UPDATE SET complete=excluded.complete`,
            [head.home, id, owner.epoch, writer.revision, rows.length < limit],
          );
          const payload: RawPage = {
            ids: [...new Set([...rows.map((r) => r.subject_id), ...eligible.ids])],
            after: last ? { route: last.route, id: last.subject_id } : after,
            complete: rows.length < limit,
            epoch: owner.epoch,
            writer: writer.revision,
          };
          await tx.query(`INSERT INTO semantic.identity_public_capture_page VALUES($1,$2,$3,$4,$5)`, [
            head.home,
            id,
            head.version,
            payload,
            currentCommand(tx).transactionId,
          ]);
          recordIdentityEpochNativeCommit(tx, 'identity-public-capture');
          return { value: payload, events: [] };
        },
      );
      // Resolve the committed native export after release. The payload is retained across lost replies.
      const exported = await withReadTransaction(
        config.pool,
        async (tx) =>
          (
            await tx.query<{ payload: RawPage }>(
              `SELECT e.payload
        FROM semantic.identity_public_capture_page e JOIN semantic.identity_epoch_native_commit c
        ON (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id) AND c.xmin=e.xmin
        JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position
        WHERE e.partition_no=$1 AND e.capture_id=$2 AND e.page_version=$3
        AND c.purpose='identity-public-capture' AND p.write_state='active' AND p.moved_to IS NULL`,
              [head.home, id, head.version],
            )
          ).rows[0],
      );
      if (!exported || digest(exported.payload) !== digest(page.value)) return { status: 'unavailable', cost };
      const raw = exported.payload;
      const committed = await runCommand(config.pool, { partition, deadline: request.context.deadline }, async (tx) => {
        const locked = (
          await tx.query<Head>(
            'SELECT * FROM semantic.identity_public_capture WHERE partition_no=$1 AND capture_id=$2 FOR UPDATE',
            [partition, id],
          )
        ).rows[0];
        if (!locked || locked.version !== head.version || locked.definition_digest !== d) throw unavailable();
        await tx.query(
          `INSERT INTO semantic.identity_public_capture_key SELECT $1,$2,o FROM unnest($3::uuid[]) o ON CONFLICT DO NOTHING`,
          [partition, id, raw.ids],
        );
        if (raw.complete && partition !== head.home)
          await tx.query(
            `INSERT INTO semantic.identity_public_capture_home VALUES($1,$2,$3,$4,$5,true)
            ON CONFLICT(partition_no,capture_id,home) DO UPDATE SET owner_epoch=excluded.owner_epoch,writer_revision=excluded.writer_revision,complete=true`,
            [partition, id, head.home, raw.epoch, raw.writer],
          );
        const home = raw.complete ? head.home + 1 : head.home;
        const completed = home === 4096;
        await tx.query(
          `UPDATE semantic.identity_public_capture SET home=$3,after_route=$4,after_id=$5,version=version+1,complete=$6,transaction_id=$7
          WHERE partition_no=$1 AND capture_id=$2`,
          [
            partition,
            id,
            home,
            raw.complete ? null : (raw.after?.route ?? null),
            raw.complete ? null : (raw.after?.id ?? null),
            completed,
            currentCommand(tx).transactionId,
          ],
        );
        recordIdentityEpochNativeCommit(tx, 'identity-public-capture');
        return { value: { completed, version: (BigInt(head.version) + 1n).toString() }, events: [] };
      });
      cost = {
        ...cost,
        inputKeys: cost.inputKeys + limit,
        resultWrites: cost.resultWrites + raw.ids.length,
        frontierWrites: cost.frontierWrites + 1,
      };
      if (!committed.value.completed)
        return {
          status: 'progress',
          captureId: id,
          frontier: `${id}:${committed.value.version}`,
          originals: raw.ids,
          cost,
        };
      const capture = Object.freeze({}) as PublicIdentitySourceCapture;
      locators.set(capture, { source: definition.source, captureId: id, definition: d });
      return { status: 'complete', captureId: id, frontier: null, originals: raw.ids, capture, cost };
    },
  };
};

/** Native committed capture + current local Source owner, on the caller's own command client. */
export async function verifyPublicIdentitySourceCapture(
  tx: CommandTransaction,
  capture: PublicIdentitySourceCapture,
): Promise<boolean> {
  const locator = publicIdentityCaptureLocator(capture);
  return locator !== null && verifyPublicIdentitySourceCaptureLocator(tx, locator);
}
export async function verifyPublicIdentitySourceCaptureLocator(
  tx: CommandTransaction,
  locator: Locator,
): Promise<boolean> {
  if (currentCommand(tx).partition !== locator.source.partition) return false;
  const result = await tx.query(
    `SELECT 1 FROM semantic.identity_public_capture c
    JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id)=(c.partition_no,c.transaction_id) AND n.xmin=c.xmin
    JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.source_epoch AND p.position>=n.position
    WHERE c.partition_no=$1 AND c.capture_id=$2 AND c.complete AND c.home=4096 AND c.definition_digest=$3
      AND c.source_id=$4 AND c.configuration=$5 AND c.source_epoch=$6
      AND n.purpose='identity-public-capture' AND p.write_state='active' AND p.moved_to IS NULL FOR SHARE OF c`,
    [
      locator.source.partition,
      locator.captureId,
      locator.definition,
      locator.source.id,
      locator.source.configuration,
      locator.source.epoch,
    ],
  );
  return result.rowCount === 1;
}

/** Native receiving uses only persisted Semantic selectors on the actual shared command. */
export async function lockPublicIdentityOutputCaptureDisposition(
  tx: CommandTransaction,
  selection: import('../library/native-public-output-contract.ts').PublicOutputDispositionSelection,
  context: import('../library/native-public-output-contract.ts').PublicOutputCommandContext,
) {
  const { resolvePublicIdentityOutputCaptureDisposition } = await import('./identity-public-output-capture.ts');
  return resolvePublicIdentityOutputCaptureDisposition(tx, selection, context);
}
