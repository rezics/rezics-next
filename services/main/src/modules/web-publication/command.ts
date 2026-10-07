import { createHash } from 'node:crypto';
import { CommandRejected, fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import {
  assertNotInvalidProfileReceipt,
  validatedCommand,
} from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import {
  AdmissionDenied,
  AdmissionExpired,
  type RegisteredAdmission,
} from '../access/admission.ts';
import {
  DATASET,
  GRAPHS,
  RV,
  hash,
  iri,
  lit,
  IdempotencyConflict,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { workEditReceiptIri } from '../work/edit.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { storeExactBytes } from './bytes.ts';
import { fetchWebSnapshot } from './fetch.ts';
import type { SnapshotTransport } from './transport.ts';
import {
  checkedSnapshotIdentity,
  decodeFixtureBytes,
  snapshotDigest,
  WEB_SNAPSHOT_COST,
  WEB_SNAPSHOT_PROFILE,
  InvalidWebSnapshot,
  SnapshotNotFound,
  WebSnapshotUnavailable,
  type SnapshotRecord,
  type SnapshotWrite,
} from './schema.ts';

export function snapshotReceiptIri(admissionId: string): string {
  return workEditReceiptIri(admissionId);
}

interface SnapshotReceipt {
  outcome: 'succeeded' | 'cancelled';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  work?: string;
  release?: string;
  snapshot?: string;
}

async function readReceipt(
  env: Pick<WorkActivationEnvironment, 'fuseki'>,
  admissionId: string,
): Promise<SnapshotReceipt | null> {
  const receipt = snapshotReceiptIri(admissionId);
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT ?outcome ?digest ?authority ?scope ?epoch ?sequence ?work ?release ?snapshot WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:admissionId ${lit(admissionId)} ;
        rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:authorityEpoch ?authority ;
        rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(receipt)} rv:work ?work ; rv:release ?release ; rv:webSnapshot ?snapshot }
      } } LIMIT 2`,
        8192,
      )
    ).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const outcome =
    row.outcome?.value === `${RV}Succeeded`
      ? 'succeeded'
      : row.outcome?.value === `${RV}Cancelled`
        ? 'cancelled'
        : null;
  if (
    rows.length !== 1 ||
    !outcome ||
    !row.digest ||
    !row.authority ||
    !row.scope ||
    !row.epoch ||
    !row.sequence ||
    (outcome === 'succeeded' && (!row.work || !row.release || !row.snapshot))
  ) {
    throw new WebSnapshotUnavailable('Snapshot receipt is incomplete');
  }
  return {
    outcome,
    receipt,
    admissionId,
    requestDigest: row.digest.value,
    authorityEpoch: row.authority.value,
    scope: row.scope.value,
    dataEpoch: row.epoch.value,
    sequence: row.sequence.value,
    ...(outcome === 'succeeded'
      ? { work: row.work!.value, release: row.release!.value, snapshot: row.snapshot!.value }
      : {}),
  };
}

async function seal(env: WorkActivationEnvironment, admission: RegisteredAdmission): Promise<void> {
  if (await readReceipt(env, admission.id)) return;
  const receipt = snapshotReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:Cancelled ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:AdmissionCancelledEvent ; rv:ordinal 0 ; rv:action "work.edit" ;
          rv:receipt ${iri(receipt)} ; rv:admissionId ${lit(admission.id)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try {
    await env.fuseki.commandWithReceipt({
      receipt,
      digest: admission.requestDigest,
      update,
      validations: [],
      deadlineMs: WEB_SNAPSHOT_COST.deadlineMs,
    });
  } catch {
    /* The receipt below is the outcome, including after a lost response. */
  }
  if (!(await readReceipt(env, admission.id)))
    throw new PendingAdmittedWork(admission.id, 'work-edit');
}

async function publication(
  env: WorkActivationEnvironment,
  work: string,
  release: string,
): Promise<{ url: string; head: string }> {
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?url ?head ?kind WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(release)} a rv:Release ; rv:work ${iri(work)} ;
      rv:releaseKind ?kind ; rv:releaseHead ?head . OPTIONAL { ${iri(release)} rv:originalUrl ?url } }
  } LIMIT 2`,
        8192,
      )
    ).results?.bindings ?? [];
  if (!rows.length) throw new SnapshotNotFound('Web publication is unavailable');
  if (rows.length !== 1 || rows[0]?.kind?.value !== 'web' || !rows[0].url || !rows[0].head) {
    throw new InvalidWebSnapshot('Snapshots belong to a web publication');
  }
  return { url: rows[0].url.value, head: rows[0].head.value };
}

async function capture(
  body: SnapshotWrite,
  url: string,
  options: {
    rightsPermitted: (origin: string) => Promise<boolean>;
    transport?: SnapshotTransport;
  },
): Promise<{ bytes: Buffer; mediaType: string; fetchedAt: string }> {
  if (body.acquisition === 'fixture') {
    return {
      bytes: decodeFixtureBytes(body.bytesBase64),
      mediaType: body.mediaType,
      fetchedAt: body.fetchedAt,
    };
  }
  return fetchWebSnapshot(url, options);
}

/** A snapshot is closed. Adding one does not revise the publication's languages or URL.
 * Bytes are stored before the graph command; the digest is the observation. */
export async function setWebSnapshot(
  deps: MainWorkDependencies,
  request: Request,
  input: {
    work: string;
    publication: string;
    idempotencyKey: string;
    body: unknown;
    rightsPermitted: (origin: string) => Promise<boolean>;
    transport?: SnapshotTransport;
  },
) {
  const body = checkedSnapshotIdentity(input.body);
  const acquisitionPrincipal = await deps.account.verify(request, ['work:edit']);
  if (!(await deps.access.canEditWork(acquisitionPrincipal, body.actingSubject, input.work))) {
    throw new AdmissionDenied('Snapshot Work edit is not admitted');
  }
  const source = await publication(deps.environment, input.work, input.publication);
  const captured = await capture(body, source.url, {
    rightsPermitted: input.rightsPermitted,
    transport: input.transport,
  });
  const byteDigest = createHash('sha256').update(captured.bytes).digest('hex');
  const record: SnapshotRecord = {
    id: body.id,
    publication: input.publication,
    work: input.work,
    acquisition: body.acquisition,
    fetchedAt: captured.fetchedAt,
    byteDigest,
    byteLength: captured.bytes.length,
    mediaType: captured.mediaType,
    coverage: body.coverage,
    actingSubject: body.actingSubject,
  };
  const digest = snapshotDigest(record);
  const signal = AbortSignal.timeout(WEB_SNAPSHOT_COST.deadlineMs);
  return fusekiReadBudget.run(
    {
      signal,
      callsLeft: WEB_SNAPSHOT_COST.commandGraphCalls,
      bytesLeft: WEB_SNAPSHOT_COST.commandGraphBytes,
    },
    async () => {
      const env = deps.environment;
      await assertGraphAdmissionOpen(env.fuseki, env.lineage);
      // Capture can outlive the Account assertion or Work grant used to start it.
      const principal = await deps.account.verify(request, ['work:edit']);
      if (!(await deps.access.canEditWork(principal, record.actingSubject, record.work))) {
        throw new AdmissionDenied('Snapshot Work edit is no longer admitted');
      }
      const registered = await deps.access.register({
        principal,
        actingSubject: record.actingSubject,
        action: 'work.edit',
        scope: `work:edit:${record.work}`,
        idempotencyKey: input.idempotencyKey,
        requestDigest: digest,
      });
      try {
        let admission = registered;
        if (registered.state !== 'sealed' && registered.dispatchEligible) {
          try {
            admission = await deps.access.claim(registered.id, digest, principal);
          } catch (error) {
            if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired))
              throw error;
            admission = { ...registered, dispatchEligible: false };
          }
        }
        let committed = false,
          failure: unknown;
        try {
          if (admission.state === 'sealed') {
            /* retry */
          } else if (!admission.dispatchEligible || admission.state === 'registered')
            await seal(env, admission);
          else if (!(await deps.access.canEditWork(principal, record.actingSubject, record.work)))
            await seal(env, admission);
          else {
            const stored = await storeExactBytes(env, captured.bytes);
            if (stored !== byteDigest)
              throw new WebSnapshotUnavailable('Snapshot bytes were not stored');
            committed = await commit(env, admission, record, source.head, digest);
          }
        } catch (error) {
          failure = error;
        }
        const terminal = await readReceipt(env, admission.id);
        if (failure instanceof InvalidWebSnapshot || failure instanceof SnapshotNotFound)
          throw failure;
        if (!terminal) {
          if (
            failure instanceof WebSnapshotUnavailable ||
            failure instanceof IdempotencyConflict ||
            failure instanceof CommandRejected
          )
            throw failure;
          throw new PendingAdmittedWork(admission.id, 'work-edit');
        }
        await deps.access.recordGraphOutcome(admission.id, terminal);
        await assertNotInvalidProfileReceipt(env.fuseki, terminal.receipt);
        if (failure instanceof CommandRejected) throw failure;
        if (terminal.outcome === 'cancelled')
          throw new InvalidWebSnapshot('Snapshot command was cancelled');
        if (terminal.snapshot !== record.id || terminal.work !== record.work) {
          throw new IdempotencyConflict('Snapshot receipt targets another snapshot');
        }
        return {
          ...record,
          receipt: terminal.receipt,
          sourcePosition: { dataEpoch: terminal.dataEpoch, sequence: terminal.sequence },
          replayed: !committed,
        };
      } catch (error) {
        if (
          error instanceof WebSnapshotUnavailable ||
          error instanceof IdempotencyConflict ||
          error instanceof CommandRejected ||
          error instanceof InvalidWebSnapshot ||
          error instanceof SnapshotNotFound
        )
          throw error;
        throw new PendingAdmittedWork(registered.id, 'work-edit');
      }
    },
  );
}

async function commit(
  env: WorkActivationEnvironment,
  admission: RegisteredAdmission,
  record: SnapshotRecord,
  head: string,
  digest: string,
): Promise<boolean> {
  const receipt = snapshotReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  if (await readReceipt(env, admission.id)) return false;
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} { ${iri(record.publication)} a rv:Release ; rv:work ${iri(record.work)} ;
      rv:releaseKind "web" ; rv:releaseHead ${iri(head)} }
    FILTER NOT EXISTS { ${iri(record.id)} ?existing ?value }
  } LIMIT 2`,
        8192,
      )
    ).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.sequence) {
    await seal(env, admission);
    return false;
  }
  const validations = await profileValidations(env.fuseki, 'web-snapshot-v1', [
    {
      shape: `${WEB_SNAPSHOT_PROFILE}/snapshot-shape`,
      focus: [record.id],
      graphs: [GRAPHS.current, GRAPHS.revisions],
    },
  ]);
  const when = `${lit(record.fetchedAt)}^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(record.id)} a rv:WebSnapshot ;
        rv:publication ${iri(record.publication)} ; rv:work ${iri(record.work)} ;
        rv:fetchedAt ${when} ; rv:byteDigest ${lit(record.byteDigest)} ;
        rv:byteLength "${record.byteLength}"^^<http://www.w3.org/2001/XMLSchema#integer> ;
        rv:coverageScope ${lit(record.coverage.scope)} ;
        rv:coverageComplete ${lit(String(record.coverage.complete))} ;
        rv:object ${iri(`urn:rezics:sha256:${record.byteDigest}`)} ;
        rv:acquisition ${lit(record.acquisition)} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:work ${iri(record.work)} ; rv:release ${iri(record.publication)} ; rv:releaseRevision ${iri(head)} ;
        rv:webSnapshot ${iri(record.id)} ; rv:action "work.edit" ; rv:commandFamily "web-snapshot-v1" ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ReleaseChangedEvent ; rv:ordinal 0 ; rv:action "work.edit" ; rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . FILTER(?n = ${rows[0].sequence.value}) }
      GRAPH ${iri(GRAPHS.current)} { ${iri(record.publication)} a rv:Release ; rv:work ${iri(record.work)} ;
        rv:releaseKind "web" ; rv:releaseHead ${iri(head)} .
        FILTER NOT EXISTS { ${iri(record.id)} ?existing ?value } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const result = await validatedCommand(
    env,
    { receipt, digest, update, validations, deadlineMs: WEB_SNAPSHOT_COST.deadlineMs },
    admission,
  );
  if (result.status === 'invalid' || result.status === 'unknown-profile')
    throw new CommandRejected(result);
  if (!(await readReceipt(env, admission.id))) {
    await seal(env, admission);
    return false;
  }
  return true;
}
