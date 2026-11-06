import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type {
  WorkApplicationPorts,
  WorkPool,
  WorkQueryClient,
  WorkScopedRequest,
  WorkSdkClient,
} from '../contract/index.ts';
import { assertScopedWorkIdentity, assertWorkIntent } from '../core/index.ts';

export function createHistoryWork(ports: Pick<WorkApplicationPorts, 'history' | 'sdkEnqueue' | 'sql'>) {
  function validate(request: WorkScopedRequest, custodyId = request.intent.workflowId) {
    ports.history.validateLocator('durable-work/v1', { artifactType: 'durable-work/v1', workId: custodyId });
    assertWorkIntent(request.intent);
    assertScopedWorkIdentity(request, custodyId);
    ports.history.validateScope('durable-work/v1', request.scope);
    const encoded = canonicalize(request);
    if (!encoded || Buffer.byteLength(encoded) > 65536) throw new TypeError('Scoped work request exceeds 64 KiB');
    return createHash('sha256').update(encoded).digest();
  }

  return {
    async stageHistoryWork(tx: WorkQueryClient, input: WorkScopedRequest): Promise<void> {
      ports.history.beginSerialization(tx);
      const request = structuredClone(input);
      const digest = validate(request);
      const command = ports.history.currentCommand(tx);
      await ports.history.guardAccounts(tx, command.partition, request.scope.accounts);
      await ports.history.persist(tx, command.partition, command.partition, command.transactionId, request, digest);
      await ports.history.recordCopy(tx, { artifactType: 'durable-work/v1', workId: request.intent.workflowId });
    },

    async receiveMappedHistoryWork(
      tx: WorkQueryClient,
      _client: WorkSdkClient,
      custodyId: string,
      source: { partition: number; transactionId: string },
      request: WorkScopedRequest,
    ): Promise<'admitted' | 'retired'> {
      const mapping = await ports.history.readIdentityMapping(tx, custodyId);
      if (mapping?.workflow_id !== request.intent.workflowId)
        throw new TypeError('Missing native identity SDK workflow mapping');
      const digest = validate(request, custodyId);
      const bound = await ports.history.bindIdentityDigest(tx, custodyId, digest);
      if (!bound) throw new TypeError('Conflicting native identity SDK request digest');
      const existing = await ports.history.lockReceiving(tx, custodyId);
      if (existing?.state === 'retired') {
        if (!Buffer.from(existing.request_digest).equals(digest))
          throw new TypeError('Conflicting retired identity work');
        return 'retired';
      }
      await ports.history.guardAccounts(tx, 0, request.scope.accounts);
      const stored = await ports.history.persist(
        tx,
        0,
        source.partition,
        source.transactionId,
        request,
        digest,
        custodyId,
      );
      if (!stored.retired) {
        const legacyCopies = !existing && (await ports.sql.hasRetainedCopies(tx, request.intent.workflowId));
        let created: boolean | undefined;
        await ports.sdkEnqueue.enqueueInTransaction(_client, tx, request.intent, (value) => {
          created = value;
        });
        if (created === undefined) throw new TypeError('Identity SDK creation seam unavailable');
        if (created && !existing && !legacyCopies) await ports.history.captureIdentityCreation(tx, custodyId);
        await ports.history.markAdmitted(tx, 0, custodyId);
      }
      return stored.retired ? 'retired' : 'admitted';
    },

    async receiveHistoryWork(
      pool: WorkPool,
      _client: WorkSdkClient,
      sourcePartition: number,
      workId: string,
    ): Promise<'admitted' | 'retired'> {
      const source = await ports.history.readOrigin(pool, sourcePartition, workId);
      if (source.state === 'retired') return 'retired';
      const request: WorkScopedRequest = { owner: source.owner, intent: source.request, scope: source.scope };
      const digest = validate(request);
      if (!digest.equals(Buffer.from(source.request_digest))) throw new TypeError('Scoped work origin digest mismatch');
      return ports.history.withConnection(pool, async (tx) => {
        await ports.history.beginSerializable(tx);
        try {
          const existing = await ports.history.lockReceiving(tx, workId);
          if (existing?.state === 'retired') {
            if (!digest.equals(Buffer.from(existing.request_digest))) throw new TypeError('Conflicting retired work');
            await ports.history.commit(tx);
            return 'retired';
          }
          await ports.history.guardAccounts(tx, 0, request.scope.accounts);
          const stored = await ports.history.persist(tx, 0, sourcePartition, source.source_transaction, request, digest);
          await ports.history.insertRecordCopies(tx, source.recordCopies, source.recordLocator);
          await ports.history.insertRecordSets(tx, source.recordSets, source.recordLocator);
          if (!stored.retired && !stored.admitted) {
            await ports.sdkEnqueue.enqueueInTransaction(_client, tx, request.intent);
            await ports.history.markAdmitted(tx, 0, workId);
          }
          await ports.history.commit(tx);
          return stored.retired ? 'retired' : 'admitted';
        } catch (error) {
          await ports.history.rollback(tx);
          throw error;
        }
      });
    },

    settleHistoryWork(
      tx: WorkQueryClient,
      input: { partition: number; workId: string; digest: Uint8Array; owner: string },
    ): Promise<void> {
      return ports.history.settleOwner(tx, input);
    },
  };
}
