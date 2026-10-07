import { createHash, createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { CommandOutcomeUnknown, CommandRejected, type CommandEnvelope, type CommandResult,
  type FusekiClient } from '../../infrastructure/fuseki.ts';
import { ObjectIntegrityError, type ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import type { ProofRetirement } from '../graph/slim-command.ts';
import { checkedEditionV2, checkedMetadataState, editionV2Digest, metadataDigest,
  type MetadataEditionState, type MetadataEditionStateV2 } from '../work/metadata-schema.ts';
import type { CustodiedOutbox, CustodiedOutboxSource, MainOutboxBatch } from './relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from './relay-position.ts';

const RV = 'https://rezics.com/vocab/';
const RECEIPTS = 'urn:rezics:graph:receipts';
const DATASET = 'urn:rezics:dataset:product';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const nativeIri = (value: string) => {
  if (!/^(?:urn:rezics:[A-Za-z0-9:._-]+|https:\/\/rezics\.com\/id\/[A-Za-z0-9._~-]+)$/.test(value)) {
    throw new Error('Invalid custody identity');
  }
  return `<${value}>`;
};

export interface CustodiedReceipt {
  outcome: 'succeeded'; receipt: string; admissionId: string; requestDigest: string;
  authorityEpoch: string; scope: string; dataEpoch: string; sequence: string; streamSequence: string;
  work: string; component: string; revision: string;
  predecessor?: string;
}
export interface SlimEnvelope extends CommandEnvelope {
  slim: { payloadSha256: string; component: string; revision: string };
}
export interface PreparedCommand {
  format: 'rezics-owner-command-v1'; envelope: CommandEnvelope;
  component: string; revision: string; manifest: string;
  routingEpoch: string; state: MetadataEditionState | MetadataEditionStateV2;
  receipt: Omit<CustodiedReceipt, 'sequence' | 'streamSequence'>;
}
export interface CommittedCustodySource {
  prepared: PreparedCommand;
  terminal: CustodiedReceipt;
  outbox: CustodiedOutboxRecord;
  payloadSha256: string;
  manifestSha256: string;
  componentPayloadSha256: string;
  model: string;
  /** Existing owner retention traversals can protect this exact source closure. */
  objectReferences: { digest: string; kind: 'command' | 'manifest' | 'payload' | 'shape' }[];
}
export interface HistoricalReceiptSource {
  outbox: CustodiedOutbox;
  objectDigests: ReadonlySet<string>;
}
export const CUSTODY_RECOVERY_COST = { commandBytes: 2_097_152, stateBytes: 65_536,
  shapeBytes: 4_194_304, selectedProfiles: 2 } as const;
export interface CustodyRow {
  receipt: string; requestDigest: string; payloadSha256: string; payload: Uint8Array;
  revision: string; terminal: CustodiedReceipt | null; outbox: Record<string, unknown> | null;
  reconciled: boolean; retired: boolean;
}
export interface ReceiptCustodySession {
  read(): Promise<CustodyRow | null>;
  prepare(row: CustodyRow): Promise<void>;
  reconcile(terminal: CustodiedReceipt, outbox: Record<string, unknown>): Promise<void>;
  retire(): Promise<void>;
}
export interface ReceiptCustodyStore {
  receiptAt(dataEpoch: string, streamSequence: string): Promise<string | null>;
  /** Serialize preparation, dispatch, reconciliation and retirement for one receipt across processes. */
  withReceipt<T>(receipt: string, operation: (session: ReceiptCustodySession) => Promise<T>): Promise<T>;
}

/** Session locks survive each durable statement: preparation is committed BEFORE the graph request. */
export class PostgresReceiptCustodyStore implements ReceiptCustodyStore {
  constructor(private readonly pool: Pool) {}
  async receiptAt(dataEpoch: string, streamSequence: string): Promise<string | null> {
    const rows = (await this.pool.query<{ receipt: string }>(`SELECT receipt FROM access.command_custody
      WHERE data_epoch = $1 AND stream_sequence = $2`, [dataEpoch, streamSequence])).rows;
    return rows[0]?.receipt ?? null;
  }
  async withReceipt<T>(receipt: string, operation: (session: ReceiptCustodySession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    let destroyed = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`command-custody:${receipt}`]);
      locked = true;
      const durable = async (write: () => Promise<void>) => {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL synchronous_commit = on');
          await write();
          await client.query('COMMIT');
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
          throw error;
        }
      };
      return await operation({
        read: async () => {
          const row = (await client.query<{ receipt: string; request_digest: string; payload_sha256: string;
            payload: Buffer; revision: string; terminal: CustodiedReceipt | null; outbox: Record<string, unknown> | null;
            reconciled: boolean; retired: boolean }>(`SELECT receipt, request_digest, payload_sha256, payload,
              revision, terminal, outbox, reconciled_at IS NOT NULL AS reconciled,
              retired_at IS NOT NULL AS retired FROM access.command_custody WHERE receipt = $1`, [receipt])).rows[0];
          return row ? { receipt: row.receipt, requestDigest: row.request_digest, payloadSha256: row.payload_sha256,
            payload: row.payload, revision: row.revision, terminal: row.terminal, outbox: row.outbox,
            reconciled: row.reconciled, retired: row.retired } : null;
        },
        prepare: row => durable(async () => {
          await client.query(`INSERT INTO access.command_custody
            (receipt, request_digest, payload_sha256, payload, revision) VALUES ($1,$2,$3,$4,$5)`,
          [receipt, row.requestDigest, row.payloadSha256, Buffer.from(row.payload), row.revision]);
        }),
        reconcile: (terminal, outbox) => durable(async () => {
          const updated = await client.query(`UPDATE access.command_custody SET terminal = $2, outbox = $3,
            data_epoch = $4, stream_sequence = $5,
            reconciled_at = clock_timestamp() WHERE receipt = $1 AND terminal IS NULL`,
          [receipt, JSON.stringify(terminal), JSON.stringify(outbox), terminal.dataEpoch, terminal.streamSequence]);
          if (updated.rowCount !== 1) throw new Error('Custody reconciliation lost its prepared command');
        }),
        retire: async () => {
          const updated = await client.query(`UPDATE access.command_custody SET retired_at = clock_timestamp()
            WHERE receipt = $1 AND reconciled_at IS NOT NULL AND terminal IS NOT NULL AND outbox IS NOT NULL`, [receipt]);
          if (updated.rowCount !== 1) throw new Error('Receipt custody is not reconciled');
        },
      });
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`command-custody:${receipt}`]); }
        catch { client.release(true); destroyed = true; }
      }
      if (!destroyed) client.release();
    }
  }
}

interface CommitProof { digest: string; payloadSha256: string; dataEpoch: string; sequence: string; streamSequence: string }
type CustodiedOutboxRecord = Omit<MainOutboxBatch, 'eventIds'> & { eventCount: number; events: CustodiedOutbox['events'] };
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, member: unknown) =>
  member && typeof member === 'object' && !Array.isArray(member)
    ? Object.fromEntries(Object.entries(member).sort(([a], [b]) => a.localeCompare(b))) : member);

/** Extends the existing receipt path; the graph proof is never the only copy of command intent. */
export class ReceiptCustody implements CustodiedOutboxSource {
  constructor(private readonly store: ReceiptCustodyStore, private readonly objects: ImmutableObjects,
    private readonly fuseki: Pick<FusekiClient, 'query'>, private readonly retirementKey: string,
    private readonly sendRetirement: (evidence: ProofRetirement) => Promise<void>) {
    if (!/^[0-9a-f]{64}$/.test(retirementKey)) throw new Error('Independent custody signing key is required');
  }

  private prepared(row: CustodyRow): PreparedCommand {
    if (sha256(row.payload) !== row.payloadSha256) throw new ObjectIntegrityError('Prepared command digest differs');
    const value = JSON.parse(Buffer.from(row.payload).toString('utf8')) as PreparedCommand;
    if (value.format !== 'rezics-owner-command-v1' || value.envelope.receipt !== row.receipt
      || value.envelope.digest !== row.requestDigest || value.receipt.receipt !== row.receipt
      || value.receipt.requestDigest !== row.requestDigest || value.revision !== row.revision
      || value.receipt.revision !== row.revision || value.receipt.component !== value.component
      || !value.routingEpoch || value.state?.kind !== 'edition' || value.state.id !== value.component) {
      throw new ObjectIntegrityError('Prepared command binding differs');
    }
    return value;
  }

  private async exactObject(row: CustodyRow): Promise<PreparedCommand> {
    const prepared = this.prepared(row);
    const bytes = await this.objects.get(row.payloadSha256);
    if (sha256(bytes) !== row.payloadSha256 || !Buffer.from(bytes).equals(Buffer.from(row.payload))) {
      throw new ObjectIntegrityError('Custodied command object differs');
    }
    // The command object also binds the exact component manifest and payload.
    const manifestDigest = prepared.manifest.replace(/^urn:rezics:sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(manifestDigest)) throw new ObjectIntegrityError('Invalid component manifest digest');
    const manifestBytes = await this.objects.get(manifestDigest);
    if (sha256(manifestBytes) !== manifestDigest) throw new ObjectIntegrityError('Component manifest differs');
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as {
      format: string; component: string; payload: string; payloadBytes: number;
      model: string; shape: string; mediaType: string;
    };
    if (manifest.format !== 'rezics-manifest-v1' || manifest.component !== prepared.component
      || manifest.mediaType !== 'application/json' || manifest.shape !== manifest.model
      || !['https://rezics.com/definition/work-metadata-details-v1',
        'https://rezics.com/definition/work-metadata-details-v2'].includes(manifest.model)
      || !/^sha256:[0-9a-f]{64}$/.test(manifest.payload)) throw new ObjectIntegrityError('Component manifest binding differs');
    const payload = await this.objects.get(manifest.payload.slice(7));
    if (sha256(payload) !== manifest.payload.slice(7) || payload.length !== manifest.payloadBytes) {
      throw new ObjectIntegrityError('Exact component payload differs');
    }
    const component = JSON.parse(Buffer.from(payload).toString('utf8')) as {
      format: string; component: string;
      state?: { revision?: string; intent?: { work?: string; expectedHead?: string | null;
        state?: MetadataEditionState | MetadataEditionStateV2 } };
    };
    if (component.format !== 'rezics-component-v1' || component.component !== prepared.component
      || component.state?.revision !== prepared.revision || component.state.intent?.work !== prepared.receipt.work
      || component.state.intent.state?.kind !== 'edition' || component.state.intent.state.id !== prepared.component
      || canonicalJson(component.state.intent.state) !== canonicalJson(prepared.state)
      || (manifest.model.endsWith('-v2')) !== ('contentLanguages' in prepared.state)
      || (prepared.receipt.predecessor !== undefined
        && (component.state.intent.expectedHead ?? prepared.component) !== prepared.receipt.predecessor)) {
      throw new ObjectIntegrityError('Component payload binding differs from the prepared command');
    }
    return prepared;
  }

  private async proof(receipt: string): Promise<CommitProof | null> {
    const rows = (await this.fuseki.query(`PREFIX rv: <${RV}> SELECT ?digest ?payload ?epoch ?sequence ?streamSequence WHERE {
      GRAPH <${RECEIPTS}> { ${nativeIri(receipt)} a rv:CommitProof ; rv:requestDigest ?digest ;
        rv:payloadDigest ?payload ; rv:dataEpoch ?epoch ; rv:sequence ?sequence ; rv:streamSequence ?streamSequence }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    if (!rows.length) return null;
    const row = rows[0]!;
    if (rows.length !== 1 || !row.digest || !row.payload || !row.epoch || !row.sequence
      || !row.streamSequence || !/^[1-9][0-9]{0,99}$/.test(row.streamSequence.value)
      || !/^[1-9][0-9]*$/.test(row.sequence.value)) throw new ObjectIntegrityError('Commit proof is ambiguous');
    return { digest: row.digest.value, payloadSha256: row.payload.value,
      dataEpoch: row.epoch.value, sequence: row.sequence.value, streamSequence: row.streamSequence.value };
  }

  private matched(row: CustodyRow, prepared: PreparedCommand, proof: CommitProof) {
    if (proof.digest !== row.requestDigest || proof.payloadSha256 !== row.payloadSha256
      || proof.dataEpoch !== prepared.receipt.dataEpoch) throw new ObjectIntegrityError('Commit proof differs from owner custody');
  }

  private outbox(row: CustodyRow, prepared: PreparedCommand, terminal: CustodiedReceipt): CustodiedOutboxRecord {
    const revised = prepared.envelope.validations.some(validation => validation.profile === 'work-metadata-details-v2');
    const batchId = `urn:rezics:outbox:${sha256(row.receipt)}`;
    return { batchId, streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: terminal.dataEpoch,
      sequence: terminal.streamSequence, graphSequence: terminal.sequence, routingEpoch: prepared.routingEpoch,
      eventCount: 1, events: [{ specversion: '1.0', id: `urn:rezics:event:${sha256(row.receipt)}`,
        source: 'https://rezics.com/services/main',
        type: revised ? 'com.rezics.work.metadata-revised.v1' : 'com.rezics.work.metadata-changed.v1',
        datacontenttype: 'application/json', data: { batchId, routingEpoch: prepared.routingEpoch, ordinal: 0,
          sourcePosition: { datasetId: 'product', dataEpoch: terminal.dataEpoch, sequence: terminal.sequence },
          relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: terminal.dataEpoch,
            sequence: terminal.streamSequence },
          receipt: { id: terminal.receipt, action: 'work.edit', outcome: terminal.outcome,
            admissionId: terminal.admissionId, requestDigest: terminal.requestDigest,
            authorityEpoch: terminal.authorityEpoch, scope: terminal.scope,
            ...revised && 'contentLanguages' in prepared.state ? { work: terminal.work, component: terminal.component,
              revision: terminal.revision, contentLanguages: prepared.state.contentLanguages }
              : { metadata: { work: terminal.work, component: terminal.component, revision: terminal.revision,
                manifest: `urn:rezics:sha256:${prepared.manifest.replace(/^urn:rezics:sha256:/, '')}` } },
          } } }] };
  }

  private committedTerminal(row: CustodyRow): CustodiedReceipt {
    if (!row.reconciled || !row.terminal || !row.outbox) throw new ObjectIntegrityError('Reconciled owner receipt is incomplete');
    const prepared = this.prepared(row);
    if (!/^[1-9][0-9]*$/.test(row.terminal.sequence) || !/^[1-9][0-9]{0,99}$/.test(row.terminal.streamSequence)
      || Object.entries(prepared.receipt).some(([key, value]) =>
        row.terminal![key as keyof CustodiedReceipt] !== value)
      || canonicalJson(row.outbox) !== canonicalJson(this.outbox(row, prepared, row.terminal))) {
      throw new ObjectIntegrityError('Durable receipt or outbox differs from the prepared command');
    }
    return row.terminal;
  }

  private async reconcile(row: CustodyRow, session: ReceiptCustodySession): Promise<CustodiedReceipt | null> {
    if (row.reconciled) return this.committedTerminal(row);
    const proof = await this.proof(row.receipt);
    if (!proof) return null;
    const prepared = await this.exactObject(row);
    this.matched(row, prepared, proof);
    const terminal = { ...prepared.receipt, sequence: proof.sequence, streamSequence: proof.streamSequence };
    const outbox = this.outbox(row, prepared, terminal);
    await session.reconcile(terminal, outbox);
    return terminal;
  }

  async resolve(receipt: string): Promise<CustodiedReceipt | null> {
    nativeIri(receipt);
    return this.store.withReceipt(receipt, async session => {
      const row = await session.read();
      return row ? this.reconcile(row, session) : null;
    });
  }

  /** Read an already committed source; recovery must never dispatch a live
   * command or turn a pending admission into historical authority. */
  async readCommitted(receipt: string): Promise<CommittedCustodySource | null> {
    nativeIri(receipt);
    return this.store.withReceipt(receipt, async session => {
      const row = await session.read();
      return row ? this.verifyCommitted(row) : null;
    });
  }

  /** The caller owns its held Access transaction and object store selection.
   * Historical reads never acquire a pool client, reconcile or consult native
   * proof/current heads, including when the original proof is retired. */
  async readHistorical(position: { dataEpoch: string; streamSequence: string },
    accessClient: PoolClient): Promise<HistoricalReceiptSource | null> {
    const { dataEpoch, streamSequence } = position;
    if (!dataEpoch || !/^[1-9][0-9]{0,99}$/.test(streamSequence)) throw new ObjectIntegrityError('Invalid historical custody position');
    const rows = (await accessClient.query<{ receipt: string; request_digest: string; payload_sha256: string;
      payload: Buffer; revision: string; terminal: CustodiedReceipt | null; outbox: Record<string, unknown> | null;
      reconciled: boolean; retired: boolean; data_epoch: string; stream_sequence: string }>(
      `SELECT receipt,request_digest,payload_sha256,payload,revision,terminal,outbox,
        reconciled_at IS NOT NULL AS reconciled,retired_at IS NOT NULL AS retired,
        data_epoch,stream_sequence::text
       FROM access.command_custody WHERE data_epoch=$1 AND stream_sequence=$2 LIMIT 2`,
      [dataEpoch,streamSequence])).rows;
    if (rows.length > 1) throw new ObjectIntegrityError('Historical custody position is ambiguous');
    const value = rows[0];
    if (!value) return null;
    const source = await this.verifyCommitted({ receipt: value.receipt, requestDigest: value.request_digest,
      payloadSha256: value.payload_sha256, payload: value.payload, revision: value.revision, terminal: value.terminal,
      outbox: value.outbox, reconciled: value.reconciled, retired: value.retired });
    if (value.data_epoch !== dataEpoch || value.stream_sequence !== streamSequence
      || source.terminal.dataEpoch !== dataEpoch || source.terminal.streamSequence !== streamSequence) {
      throw new ObjectIntegrityError('Historical custody position differs from its exact terminal');
    }
    return { outbox: this.deliveredOutbox(source.terminal.receipt,source.outbox),
      objectDigests: new Set(source.objectReferences.map(reference => reference.digest)) };
  }

  private async verifyCommitted(row: CustodyRow): Promise<CommittedCustodySource> {
    nativeIri(row.receipt);
    if (!row.reconciled || !row.terminal || !row.outbox
      || row.payload.byteLength > CUSTODY_RECOVERY_COST.commandBytes) {
      throw new ObjectIntegrityError('Retained command is not bounded committed custody');
    }
    const terminal = this.committedTerminal(row);
    const prepared = await this.exactObject(row);
    if (Buffer.byteLength(JSON.stringify(prepared.state)) > CUSTODY_RECOVERY_COST.stateBytes) {
      throw new ObjectIntegrityError('Retained edition state exceeds its byte bound');
    }
    const manifestSha256 = prepared.manifest.slice(-64);
    const manifestBytes = await this.objects.get(manifestSha256);
    if (sha256(manifestBytes) !== manifestSha256) throw new ObjectIntegrityError('Retained component manifest differs');
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as {
      payload: string; model: string;
    };
    const model = manifest.model;
    const state = model.endsWith('-v2') ? checkedEditionV2(prepared.state) : checkedMetadataState(prepared.state);
    const expectedHead = terminal.predecessor === prepared.component ? null : terminal.predecessor;
    if (state.kind !== 'edition' || expectedHead === undefined || canonicalJson(state) !== canonicalJson(prepared.state)
      || ('contentLanguages' in state
        ? editionV2Digest({ work: terminal.work,expectedHead,state })
        : metadataDigest({ work: terminal.work,expectedHead,state })) !== terminal.requestDigest) {
      throw new ObjectIntegrityError('Retained edition intent differs from its exact request');
    }
    const profile = model.slice('https://rezics.com/definition/'.length);
    const expected = [
      { profile: 'work-metadata-details-v1', role: 'work', focus: prepared.receipt.work },
      { profile, role: 'component', focus: prepared.component },
      { profile, role: 'revision', focus: prepared.revision },
    ];
    const validations = prepared.envelope.validations;
    if (!Array.isArray(validations) || validations.length !== expected.length
      || expected.some(entry => validations.filter(validation => validation && typeof validation === 'object'
        && validation.profile === entry.profile
        && validation.shape === `https://rezics.com/definition/${entry.profile}/${entry.role}-shape`
        && Array.isArray(validation.focus) && Array.isArray(validation.graphs)
        && validation.focus.length === 1 && validation.focus[0] === entry.focus
        && validation.graphs.length === 2 && new Set(validation.graphs).size === 2
        && validation.graphs.includes('urn:rezics:graph:current')
        && validation.graphs.includes('urn:rezics:graph:revisions')
        && validation.binding === undefined && /^[0-9a-f]{64}$/.test(validation.sha256)).length !== 1)) {
      throw new ObjectIntegrityError('Retained edition validation pins differ from their exact source');
    }
    const shapeDigests = new Set(validations.map(validation => validation.sha256));
    if (shapeDigests.size > CUSTODY_RECOVERY_COST.selectedProfiles
      || expected.some(entry => new Set(validations.filter(validation => validation.profile === entry.profile)
        .map(validation => validation.sha256)).size !== 1)) {
      throw new ObjectIntegrityError('Retained profile shape identity is ambiguous');
    }
    for (const digest of shapeDigests) {
      const bytes = await this.objects.get(digest);
      if (bytes.byteLength > CUSTODY_RECOVERY_COST.shapeBytes || sha256(bytes) !== digest) {
        throw new ObjectIntegrityError('Retained profile artifact differs from its exact pin');
      }
    }
    return {
      prepared, terminal: structuredClone(terminal), outbox: this.outbox(row, prepared, terminal),
      payloadSha256: row.payloadSha256, manifestSha256,
      componentPayloadSha256: manifest.payload.slice(7), model,
      objectReferences: [
        { digest: row.payloadSha256, kind: 'command' },
        { digest: manifestSha256, kind: 'manifest' },
        { digest: manifest.payload.slice(7), kind: 'payload' },
        ...[...shapeDigests].sort().map(digest => ({ digest, kind: 'shape' as const })),
      ],
    };
  }

  private deliveredOutbox(receipt: string, retained: CustodiedOutboxRecord): CustodiedOutbox {
    return { batch: { batchId: retained.batchId,streamScope: retained.streamScope,
      dataEpoch: retained.dataEpoch,sequence: retained.sequence,graphSequence: retained.graphSequence,
      routingEpoch: retained.routingEpoch,eventIds: retained.events.map(event => event.id),custodiedReceipt: receipt },
    events: retained.events };
  }

  /** The existing relay probes one indexed owner position; an interrupted
   * reconciliation resolves the exact native proof before the handoff proceeds. */
  async read(dataEpoch: string, streamSequence: string): Promise<CustodiedOutbox | null> {
    if (!dataEpoch || !/^[1-9][0-9]{0,99}$/.test(streamSequence)) throw new ObjectIntegrityError('Invalid owner outbox position');
    let receipt = await this.store.receiptAt(dataEpoch, streamSequence);
    if (!receipt) {
      const rows = (await this.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt WHERE {
        GRAPH <${RECEIPTS}> { ?receipt a rv:CommitProof ; rv:dataEpoch ${JSON.stringify(dataEpoch)} ;
          rv:streamSequence ${streamSequence} }
      } LIMIT 2`, 4096)).results?.bindings ?? [];
      if (rows.length > 1 || rows.length === 1 && !rows[0]?.receipt) throw new ObjectIntegrityError('Owner proof position is ambiguous');
      receipt = rows[0]?.receipt?.value ?? null;
    }
    if (!receipt) return null;
    nativeIri(receipt);
    return this.store.withReceipt(receipt, async session => {
      const row = await session.read();
      if (!row) return null;
      const terminal = await this.reconcile(row, session);
      if (!terminal) return null;
      if (terminal.dataEpoch !== dataEpoch || terminal.streamSequence !== streamSequence) {
        throw new ObjectIntegrityError('Custodied outbox position differs');
      }
      const prepared = await this.exactObject(row);
      const retained = this.outbox(row, prepared, terminal);
      return this.deliveredOutbox(receipt,retained);
    });
  }

  /** Terminal cancellations race the same serialized receipt, including proof retirement. */
  async guardCancellation(receipt: string, dispatch: () => Promise<void>): Promise<CustodiedReceipt | null> {
    nativeIri(receipt);
    return this.store.withReceipt(receipt, async session => {
      const row = await session.read();
      const terminal = row ? await this.reconcile(row, session) : null;
      if (terminal) return terminal;
      await dispatch();
      return null;
    });
  }

  async commit(input: Omit<PreparedCommand, 'format'> & {
    dispatch: (envelope: CommandEnvelope) => Promise<CommandResult>;
  }): Promise<CommandResult> {
    nativeIri(input.envelope.receipt); nativeIri(input.component); nativeIri(input.revision);
    if (input.receipt.outcome !== 'succeeded' || input.receipt.receipt !== input.envelope.receipt
      || input.receipt.requestDigest !== input.envelope.digest || input.receipt.component !== input.component
      || input.receipt.revision !== input.revision || !input.routingEpoch
      || input.state.kind !== 'edition' || input.state.id !== input.component
      || !/^[0-9a-f]{64}$/.test(input.envelope.digest)) {
      throw new ObjectIntegrityError('Slim command receipt binding differs');
    }
    return this.store.withReceipt(input.envelope.receipt, async session => {
      let row = await session.read();
      if (row && row.requestDigest !== input.envelope.digest) throw new CommandRejected({ status: 'conflict' });
      if (row) {
        const terminal = await this.reconcile(row, session);
        if (terminal) return { status: 'committed', position: {
          datasetId: DATASET, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence } };
      } else {
        const { dispatch: _dispatch, ...fields } = input;
        const payload = Buffer.from(JSON.stringify({ format: 'rezics-owner-command-v1', ...fields }));
        row = { receipt: input.envelope.receipt, requestDigest: input.envelope.digest, payload,
          payloadSha256: sha256(payload), revision: input.revision, terminal: null,
          outbox: null, reconciled: false, retired: false };
        await session.prepare(row);
      }
      const digest = await this.objects.put(row.payload);
      if (digest !== row.payloadSha256) throw new ObjectIntegrityError('Command storage returned a different digest');
      const prepared = await this.exactObject(row);
      const envelope: SlimEnvelope = { ...prepared.envelope, slim: {
        payloadSha256: row.payloadSha256, component: prepared.component, revision: prepared.revision } };
      let result: CommandResult | undefined;
      try { result = await input.dispatch(envelope); }
      catch (error) { if (!(error instanceof CommandOutcomeUnknown)) throw error; }
      const terminal = await this.reconcile(row, session);
      if (terminal) {
        if (result?.status === 'committed' && (result.position.dataEpoch !== terminal.dataEpoch
          || result.position.sequence !== terminal.sequence || result.position.datasetId !== DATASET)) {
          throw new ObjectIntegrityError('Command response differs from reconciled receipt');
        }
        return { status: 'committed', position: { datasetId: DATASET,
          dataEpoch: terminal.dataEpoch, sequence: terminal.sequence } };
      }
      if (result?.status === 'committed') throw new CommandOutcomeUnknown('Committed graph proof could not be reconciled');
      if (result) return result;
      throw new CommandOutcomeUnknown('Slim command receipt is still pending');
    });
  }

  /** Only this method can sign retirement, after reading both durable receipt and exact objects again. */
  async retire(receipt: string): Promise<void> {
    nativeIri(receipt);
    await this.store.withReceipt(receipt, async session => {
      const row = await session.read();
      if (!row?.reconciled || !row.terminal || !row.outbox) throw new Error('Receipt custody has not been reconciled');
      await this.reconcile(row, session);
      if (row.retired) return;
      const prepared = await this.exactObject(row);
      const proof = await this.proof(receipt);
      if (proof) {
        this.matched(row, prepared, proof);
        if (proof.sequence !== row.terminal.sequence || proof.streamSequence !== row.terminal.streamSequence) {
          throw new ObjectIntegrityError('Receipt position differs');
        }
      }
      const fields = ['rezics-commit-proof-retirement-v1', receipt, row.requestDigest,
        row.payloadSha256, row.terminal.dataEpoch, row.terminal.sequence, row.terminal.streamSequence];
      const signature = createHmac('sha256', this.retirementKey).update(JSON.stringify(fields)).digest('hex');
      await this.sendRetirement({ receipt, digest: row.requestDigest, payloadSha256: row.payloadSha256,
        dataEpoch: row.terminal.dataEpoch, sequence: row.terminal.sequence,
        streamSequence: row.terminal.streamSequence, signature });
      await session.retire();
    });
  }
}
