import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { typeLocales } from '../../../../../packages/model/src/generated/types.ts';
import { iri as modelTerms } from '../../../../../packages/model/src/generated/vocabulary.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import {
  ControlConflict,
  ControlDenied,
  ControlInvalid,
  ControlStale,
  ControlUnavailable,
  controlTransaction,
  lockGate,
  mandateFor,
  requireCeiling,
  requirePrincipal,
} from '../access/topology-control.ts';
import {
  TYPES_READ_COST,
  typeAdmission,
  typeRetirement,
  type TypeAdmission,
  type TypeAdmissionResult,
  type TypeDefinition,
  type TypeRetirement,
} from './contract.ts';
import {
  assertRegisteredTypeSnapshot,
  compiledType,
  installRegisteredTypes,
  type RegisteredType,
} from './registry.ts';

const SCOPE = 'type:admit';
const ACTION = 'type.admit';
const structuralTerms = new Set<string>(Object.values(modelTerms));
interface TypeRow {
  type_iri: string;
  base: TypeDefinition['base'];
  labels: TypeDefinition['labels'];
  presentation: TypeDefinition['presentation'];
  cover: TypeDefinition['cover'];
  creation: TypeDefinition['creation'];
  interest: TypeDefinition['interest'];
  primary_action: TypeDefinition['primaryAction'];
  priority: string;
  revision: string;
  lifecycle: RegisteredType['lifecycle'];
}
const columns = `type_iri, base, labels, presentation, cover, creation, interest,
  primary_action, priority::text, revision::text, lifecycle`;
const fromRow = (row: TypeRow): RegisteredType => ({
  definition: {
    type: row.type_iri,
    base: row.base,
    labels: row.labels,
    presentation: row.presentation,
    cover: row.cover,
    creation: row.creation,
    interest: row.interest,
    primaryAction: row.primary_action,
    priority: Number(row.priority),
    default: false,
    creatable: row.base === 'work' && row.lifecycle === 'active',
  },
  revision: row.revision,
  lifecycle: row.lifecycle,
});

/** Descriptive admission uses the existing Access transaction and authority fences.
 * A single gate lock serializes bounded registry writes and receipt retries. */
export class AdmittedTypeStore {
  private expiresAt = 0;
  private refreshing?: Promise<void>;
  private refreshFailure?: unknown;
  /** Catalog load shared by the requests currently inside `openRequest`. */
  private openRequests = 0;
  private openLoad?: Promise<void>;
  constructor(
    private readonly pool: Pool,
    private readonly now = Date.now,
  ) {}

  private async rows(client: PoolClient): Promise<RegisteredType[]> {
    const result = await client.query<TypeRow>(
      `SELECT ${columns} FROM access.admitted_type
      ORDER BY type_iri LIMIT $1`,
      [TYPES_READ_COST.maxTypes + 1],
    );
    return result.rows.map(fromRow);
  }

  /** Brackets one HTTP request. Does not query: a request that never reads types
   * pays no catalog transaction. Pair with `endRequest` after the response. */
  openRequest(): void {
    this.openRequests++;
  }

  /** First catalog read in the open request. Concurrent readers share it. A
   * previous request's snapshot is not reused: admission can change between
   * requests, and page size must not decide whether this request pays the read. */
  ensureRequest(): Promise<void> {
    return this.refresh(false);
  }

  /** Opens a request and reads the catalog. Callers that only need the bracket
   * use `openRequest` and let the first type read call `ensureRequest`. */
  beginRequest(): Promise<void> {
    this.openRequest();
    return this.ensureRequest();
  }

  /** Drops this request's claim on the catalog load. The next request reads again. */
  endRequest(): void {
    if (this.openRequests === 0) return;
    this.openRequests--;
    if (this.openRequests === 0) this.openLoad = undefined;
  }

  /** Direct callers reuse a successful snapshot until the TTL. Inside a request,
   * the first read loads and later reads share it, including after the TTL. */
  async refresh(force = false): Promise<void> {
    if (!force && this.openRequests > 0) {
      if (!this.openLoad) {
        this.openLoad = this.refreshFailure && this.now() < this.expiresAt
          ? Promise.reject(this.refreshFailure)
          : this.readCatalog();
      }
      return this.openLoad;
    }
    if (this.refreshing) {
      await this.refreshing;
      if (force) return this.refresh(true);
      return;
    }
    if (!force && this.now() < this.expiresAt) {
      if (this.refreshFailure) throw this.refreshFailure;
      return;
    }
    await this.readCatalog();
  }

  private async readCatalog(): Promise<void> {
    if (this.refreshing) {
      await this.refreshing;
      return;
    }
    // The fence lock and the catalog rows are one statement, so this read does not
    // open a second transaction of BEGIN, timeouts, a fence SELECT and COMMIT.
    this.refreshing = this.catalogRows().then((rows) => {
      installRegisteredTypes(rows);
      this.expiresAt = this.now() + TYPES_READ_COST.ttlMs;
      this.refreshFailure = undefined;
    }).catch((error: unknown) => {
      // Retain the installed snapshot and bound retry work while the owner is held.
      this.expiresAt = this.now() + TYPES_READ_COST.ttlMs;
      this.refreshFailure = error;
      throw error;
    });
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async catalogRows(): Promise<RegisteredType[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<TypeRow & { fence_open: boolean }>(
        `WITH fence AS MATERIALIZED (
          SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE)
        SELECT fence.open AS fence_open, admitted.type_iri, admitted.base, admitted.labels,
          admitted.presentation, admitted.cover, admitted.creation, admitted.interest,
          admitted.primary_action, admitted.priority, admitted.revision, admitted.lifecycle
        FROM fence
        LEFT JOIN LATERAL (
          SELECT ${columns} FROM access.admitted_type
          ORDER BY type_iri LIMIT $1
        ) admitted ON fence.open`,
        [TYPES_READ_COST.maxTypes + 1],
      );
      if (result.rows[0]?.fence_open !== true) throw new ControlUnavailable('Access recovery is held');
      return result.rows.filter((row) => row.type_iri != null).map(fromRow);
    } finally {
      client.release();
    }
  }

  async admit(principal: VerifiedPrincipal, input: TypeAdmission): Promise<TypeAdmissionResult> {
    if (!Value.Check(typeAdmission, input)) throw new ControlInvalid('Invalid Type admission');
    // Model vocabulary cannot be re-admitted as descriptive metadata with another base.
    if (structuralTerms.has(input.type) || compiledType(input.type))
      throw new ControlConflict('Type is already defined by the model');
    for (const locale of typeLocales)
      for (const label of Object.values(input.labels[locale])) {
        if (label !== label.trim() || /[\u0000-\u001f\u007f]/u.test(label))
          throw new ControlInvalid('Type labels must be nonempty printable names');
      }
    const definition: TypeDefinition = {
      type: input.type,
      base: input.base,
      default: false,
      creatable: input.base === 'work',
      creation: input.creation,
      interest: input.interest,
      primaryAction: input.primaryAction,
      presentation: input.presentation,
      cover: input.cover,
      priority: input.priority,
      labels: Object.fromEntries(
        typeLocales.map((locale) => [
          locale,
          { one: input.labels[locale].one, other: input.labels[locale].other },
        ]),
      ) as TypeDefinition['labels'],
    };
    return this.write(principal, input, { action: 'admit', definition }, async (client) => {
      const rows = await this.rows(client);
      if (rows.some((row) => row.definition.type === input.type))
        throw new ControlConflict('Type is already admitted');
      try {
        assertRegisteredTypeSnapshot([...rows, { definition, revision: '1', lifecycle: 'active' }]);
      } catch {
        throw new ControlConflict('Type registry inventory or byte bound exceeded');
      }
      const row = (
        await client.query<TypeRow>(
          `INSERT INTO access.admitted_type
        (type_iri, base, labels, presentation, cover, creation, interest, primary_action, priority, admitted_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`,
          [
            definition.type,
            definition.base,
            JSON.stringify(definition.labels),
            definition.presentation,
            definition.cover,
            definition.creation,
            definition.interest,
            definition.primaryAction,
            definition.priority,
            input.actingSubject,
          ],
        )
      ).rows[0]!;
      return fromRow(row);
    });
  }

  async retire(principal: VerifiedPrincipal, input: TypeRetirement): Promise<TypeAdmissionResult> {
    if (!Value.Check(typeRetirement, input)) throw new ControlInvalid('Invalid Type retirement');
    return this.write(
      principal,
      input,
      { action: 'retire', type: input.type, expectedRevision: input.expectedRevision },
      async (client) => {
        const row = (
          await client.query<TypeRow>(
            `UPDATE access.admitted_type
        SET lifecycle = 'retired', revision = revision + 1
        WHERE type_iri = $1 AND revision = $2 AND lifecycle = 'active' RETURNING ${columns}`,
            [input.type, input.expectedRevision],
          )
        ).rows[0];
        if (!row) throw new ControlStale('Type revision is stale or unavailable');
        return fromRow(row);
      },
    );
  }

  private async write(
    principal: VerifiedPrincipal,
    input: Pick<TypeAdmission, 'actingSubject' | 'idempotencyKey'>,
    intent: object,
    effect: (client: PoolClient) => Promise<RegisteredType>,
  ): Promise<TypeAdmissionResult> {
    const digest = createHash('sha256')
      .update(JSON.stringify({ ...intent, actingSubject: input.actingSubject }))
      .digest('hex');
    const result = await controlTransaction(this.pool, async (client) => {
      await lockGate(client, SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      const mandate =
        (await mandateFor(client, actor.id, input.actingSubject, ACTION)) ??
        (await mandateFor(client, actor.id, input.actingSubject, 'agent.control'));
      if (!mandate) throw new ControlDenied('Type admission requires a current Agent mandate');
      await requireCeiling(client, input.actingSubject, ACTION, undefined, SCOPE);
      const prior = (
        await client.query<{ request_digest: string; result: TypeAdmissionResult }>(
          `SELECT request_digest, result FROM access.type_admission_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`,
          [actor.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_digest !== digest)
          throw new ControlConflict('Idempotency key binds another Type intent');
        return { ...prior.result, replayed: true };
      }
      const registered = await effect(client);
      const saved: TypeAdmissionResult = {
        profile: 'type-admission-result-v1',
        ...registered,
        replayed: false,
      };
      await client.query(
        `INSERT INTO access.type_admission_receipt
        (principal_id, idempotency_key, request_digest, result) VALUES ($1,$2,$3,$4)`,
        [actor.id, input.idempotencyKey, digest, JSON.stringify(saved)],
      );
      return saved;
    });
    // A lost response is recoverable from the committed receipt if refresh is unavailable.
    await this.refresh(true);
    return result;
  }
}
