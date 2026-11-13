import { ACCESS_WORK_AXES, EMPTY_ACCESS_WORK, AccessWorkUnavailableError, type AccessWork } from '../access/work.ts';
import type {
  ResourceEligibilityOptions,
  ResourceEligibilityPrepareContext,
  ResourceEligibilityVerifyContext,
} from '../access/eligibility.ts';
import type { RevisionDisclosureReaderGate } from './revision-disclosure-model.ts';
import read from './read-chain.sql';

type Point = Readonly<{ kind: string; id: string; thread_id: string | null }>;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const uuid = 'x'.repeat(36);
const timestamp = 'x'.repeat(64);

/** Closed read-chain.sql projections for include_body=false. Schema bounds:
 * board/thread title <=1024 Unicode characters (<=6 JSON bytes each), positive
 * bigint security revision <=19 digits, UUIDs 36 bytes, timestamps <=64 bytes.
 * The post branch reads head availability/transaction/time, NEVER head bytes,
 * digest, citation or arrays. No old row's payload sizes enter admission.
 */
function projection(kind: string): object | undefined {
  const common = {
    kind,
    id: uuid,
    thread_id: null,
    board_id: null,
    parent_id: null,
    author_id: null,
    head_id: null,
    first_post_id: null,
    title: null,
    visibility: 'taken_down',
    security_revision: '9'.repeat(19),
    availability: 'available',
    created_at: timestamp,
    licence: null,
    subject_ids: null,
    media_ids: null,
    body: null,
    sha256: null,
    revised_at: null,
    thread_kind: null,
    board_purpose: null,
    vote_citation: null,
    realm_id: null,
    deleted_at: null,
    restorable: false,
    decision_id: null,
    revision_restriction: null,
    revision_restriction_decision_id: null,
  };
  switch (kind) {
    case 'board':
      return { ...common, title: '\u0001'.repeat(1024), board_purpose: 'discussion', realm_id: uuid };
    case 'thread':
      return {
        ...common,
        thread_id: uuid,
        board_id: uuid,
        author_id: uuid,
        first_post_id: uuid,
        title: '\u0001'.repeat(1024),
        thread_kind: 'discussion',
      };
    case 'post':
      return {
        ...common,
        thread_id: uuid,
        parent_id: uuid,
        author_id: uuid,
        head_id: uuid,
        revised_at: timestamp,
        deleted_at: timestamp,
        decision_id: uuid,
        revision_restriction: 'hard',
        revision_restriction_decision_id: uuid,
      };
    default:
      // Revision has a different native projection, including digest, arrays and
      // citation (and optionally body). It is not this callback's head probe.
      return undefined;
  }
}

function add(a: AccessWork, b: AccessWork): AccessWork {
  return Object.freeze(Object.fromEntries(ACCESS_WORK_AXES.map((axis) => [axis, a[axis] + b[axis]]))) as AccessWork;
}

/** Only the readResource callbacks use this owner receipt. The parent Access
 * accounting reserves its envelope before either callback; these explicit native
 * call sites record dispatched plans, not rowCount or a SQL-text classification.
 * No checkout, body read, ancestry walk or precomputed evidence is charged here.
 */
export function createReadEligibilityWork<E extends object>(
  row: Point,
  route: number,
  evidence: E,
  bookGate?: RevisionDisclosureReaderGate,
) {
  type Verify = ResourceEligibilityVerifyContext<E>;
  type Receipt = {
    spent: AccessWork;
    point: boolean;
    disclosure: boolean;
    source: boolean;
    bans: number;
    result?: boolean;
  };
  const prepared = new WeakMap<ResourceEligibilityPrepareContext, { result?: E }>();
  const receipts = new WeakMap<Verify, Receipt>();
  const input = { route, id: row.id, kind: row.kind, thread_id: row.thread_id ?? row.id, include_body: false };
  const parameters = read.params.map((name) => input[name as keyof typeof input]);
  // read-chain.sql's input is one scalar tuple. The constant kind prunes all
  // other UNION branches. board/thread: one unique point + one equality join +
  // one union output. post: post/head/decision unique points + two equality
  // joins + one union output. decision's (route,kind,id,security_revision) UNIQUE
  // and revision's (route,id) PK bound every intermediate to one, even on misses.
  // A post additionally probes its one active exact head restriction.
  const probes = row.kind === 'post' ? 4 : 1;
  const shape = projection(row.kind);
  const pointBound: AccessWork | undefined =
    shape &&
    Object.freeze({
      keys: probes,
      points: probes + 1,
      witnesses: 0,
      rows: 1 + probes + (row.kind === 'post' ? 3 : 1) + 1,
      bytes: bytes(parameters) + bytes([shape]),
      emptySeeks: 1,
    });
  // ban-current.sql: realm_ban_current is UNIQUE(route,realm_id,account_id)
  // WHERE upper_inf(valid), INCLUDE(valid). The current-time predicate cannot
  // widen that one candidate; projection is just one boolean. At most two fixed
  // identities (actor and delegating principal), never membership/history work.
  const banBound: AccessWork = Object.freeze({
    keys: 1,
    points: 1,
    witnesses: 0,
    rows: 1,
    bytes: bytes([65535, uuid, uuid, timestamp]) + bytes([{ banned: true }]),
    emptySeeks: 1,
  });
  const bookMatchesPoint = (gate: RevisionDisclosureReaderGate) => {
    const target = gate.observation.target;
    return (
      (row.kind === 'thread' && row.id === target.threadId) ||
      (row.kind === 'post' && row.id === target.postId && row.thread_id === target.threadId)
    );
  };
  const book = bookGate && bookMatchesPoint(bookGate) ? bookGate : undefined;
  const disclosureParameters = book ? [route, book.observation.disclosureId] : undefined;
  const sourceParameters = book
    ? [
        route,
        book.observation.target.threadId,
        book.observation.target.postId,
        book.observation.target.revisionId,
        book.observation.target.sha256,
        book.observation.incarnation.postTransactionId,
        book.observation.incarnation.threadTransactionId,
      ]
    : undefined;
  // Current consent uses one disclosure PK read. This full row's bounded values
  // include the validated 66,047-byte maximum serialized scopes array.
  const disclosureProjection = book
    ? {
        route: 65535,
        disclosure_id: uuid,
        operation_id: uuid,
        thread_id: uuid,
        post_id: uuid,
        revision_id: uuid,
        sha256: 'f'.repeat(64),
        licence: '!'.repeat(128),
        catalogue_id: uuid,
        catalogue_route: 65535,
        source_post_transaction_id: uuid,
        source_thread_transaction_id: uuid,
        source_post_security_revision: '9'.repeat(19),
        source_thread_security_revision: '9'.repeat(19),
        issuer_account_id: uuid,
        issued_transaction_id: uuid,
        issued_at: timestamp,
        audience_kind: 'book-publication',
        policy_version: '9'.repeat(9),
        actor_client_id: '!'.repeat(1024),
        actor_scopes: Array.from({ length: 512 }, () => '!'.repeat(128)),
        actor_requested_by: '!'.repeat(128),
        actor_authn_epoch: '9'.repeat(19),
        original_minimum_authn_epoch: '9'.repeat(19),
        original_operator_account_id: uuid,
        original_delegation_transaction_id: uuid,
        original_delegation_issued_valid: '!'.repeat(256),
        source_digest: 'f'.repeat(64),
        creation_idempotency_key: '!'.repeat(255),
        creation_request_digest: 'f'.repeat(64),
        revoked_at: timestamp,
        revocation_transaction_id: uuid,
        revoker_account_id: uuid,
      }
    : undefined;
  const disclosureBound: AccessWork | undefined =
    disclosureParameters && disclosureProjection
      ? Object.freeze({
          keys: 1,
          points: 2,
          witnesses: 0,
          rows: 3,
          bytes: bytes(disclosureParameters) + bytes([disclosureProjection]),
          emptySeeks: 1,
        })
      : undefined;
  // The exact current-source plan joins three routed primary keys and returns
  // at most the selected post id.
  const sourceBound: AccessWork | undefined = sourceParameters
    ? Object.freeze({
        keys: 3,
        points: 4,
        witnesses: 0,
        rows: 7,
        bytes: bytes(sourceParameters) + bytes([{ post_id: book!.observation.target.postId }]),
        emptySeeks: 1,
      })
    : undefined;
  const identities = (context: Verify) =>
    context.actor.kind === 'account'
      ? new Set([
          context.actor.accountId,
          ...(context.actor.requestedBy?.split(':')[3] ? [context.actor.requestedBy.split(':')[3]!] : []),
        ]).size
      : 0;
  const work: NonNullable<ResourceEligibilityOptions<E>['work']> = {
    prepare: {
      bound(context) {
        prepared.set(context, {});
        return EMPTY_ACCESS_WORK;
      },
      actual(context, result) {
        const observed = prepared.get(context);
        prepared.delete(context);
        return observed?.result === evidence && result === evidence ? EMPTY_ACCESS_WORK : undefined;
      },
    },
    verify: {
      bound(context) {
        receipts.delete(context);
        if (!pointBound)
          throw new (AccessWorkUnavailableError())(
            `Content read eligibility ${row.kind} projection native work producer`,
          );
        if (
          context.evidence !== evidence ||
          context.resource.route !== route ||
          context.resource.id !== row.id ||
          context.action !== `${row.kind}:read`
        )
          return undefined;
        receipts.set(context, {
          spent: EMPTY_ACCESS_WORK,
          point: false,
          disclosure: false,
          source: false,
          bans: 0,
        });
        // A changed board signature denies before bans. Reserving both possible
        // keys also covers the current board branch without trusting stale realm
        // or publication metadata to authorize it.
        let bound = pointBound;
        if (disclosureBound && sourceBound) bound = add(add(bound, disclosureBound), sourceBound);
        if (row.kind === 'board') for (let i = 0; i < identities(context); i++) bound = add(bound, banBound);
        return bound;
      },
      actual(context, result) {
        const receipt = receipts.get(context);
        receipts.delete(context);
        return receipt?.point && receipt.result === result ? receipt.spent : undefined;
      },
    },
  };
  return {
    work,
    prepare(context: ResourceEligibilityPrepareContext) {
      const receipt = prepared.get(context);
      if (receipt) receipt.result = evidence;
      return evidence;
    },
    async point<R extends object>(context: Verify, dispatch: () => Promise<R | null>): Promise<R | null> {
      const receipt = receipts.get(context);
      if (receipt) {
        if (receipt.point || !pointBound) throw new Error('Duplicate content eligibility point dispatch');
        receipt.point = true;
        receipt.spent = add(receipt.spent, pointBound!);
      }
      const result = await dispatch();
      if (receipt)
        receipt.spent = Object.freeze({
          ...receipt.spent,
          bytes: receipt.spent.bytes - pointBound!.bytes + bytes(parameters) + bytes(result === null ? [] : [result]),
          emptySeeks: receipt.spent.emptySeeks - (result === null ? 0 : 1),
        });
      return result;
    },
    async disclosure<R extends object>(context: Verify, dispatch: () => Promise<R | null>): Promise<R | null> {
      const receipt = receipts.get(context);
      if (!receipt) return dispatch();
      if (!disclosureBound || receipt.disclosure) throw new Error('Unexpected content eligibility disclosure dispatch');
      receipt.disclosure = true;
      receipt.spent = add(receipt.spent, disclosureBound);
      const result = await dispatch();
      receipt.spent = Object.freeze({
        ...receipt.spent,
        bytes:
          receipt.spent.bytes -
          disclosureBound.bytes +
          bytes(disclosureParameters!) +
          bytes(result === null ? [] : [result]),
        emptySeeks: receipt.spent.emptySeeks - (result === null ? 0 : 1),
      });
      return result;
    },
    async source(context: Verify, dispatch: () => Promise<boolean>): Promise<boolean> {
      const receipt = receipts.get(context);
      if (!receipt) return dispatch();
      if (!sourceBound || !receipt.disclosure || receipt.source)
        throw new Error('Unexpected content eligibility source dispatch');
      receipt.source = true;
      receipt.spent = add(receipt.spent, sourceBound);
      const result = await dispatch();
      receipt.spent = Object.freeze({
        ...receipt.spent,
        bytes:
          receipt.spent.bytes -
          sourceBound.bytes +
          bytes(sourceParameters!) +
          bytes(result ? [{ post_id: book!.observation.target.postId }] : []),
        emptySeeks: receipt.spent.emptySeeks - (result ? 1 : 0),
      });
      return result;
    },
    async ban<R extends { rows: { banned: boolean }[] }>(
      context: Verify,
      parameters: readonly unknown[],
      dispatch: () => Promise<R>,
    ): Promise<R> {
      const receipt = receipts.get(context);
      if (receipt) {
        if (row.kind !== 'board' || !receipt.point || receipt.bans >= identities(context))
          throw new Error('Unexpected content eligibility ban dispatch');
        receipt.bans++;
        receipt.spent = add(receipt.spent, banBound);
      }
      const result = await dispatch();
      if (receipt)
        receipt.spent = Object.freeze({
          ...receipt.spent,
          bytes: receipt.spent.bytes - banBound.bytes + bytes(parameters) + bytes(result.rows),
          emptySeeks: receipt.spent.emptySeeks - (result.rows.length === 0 ? 0 : 1),
        });
      return result;
    },
    complete(context: Verify, result: boolean) {
      const receipt = receipts.get(context);
      if (receipt) receipt.result = result;
      return result;
    },
  };
}
