import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { AwsClient } from 'aws4fetch';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../services/main/src/modules/work/activate.ts';
import { readEnv, replacePrivate } from '../dev/config.ts';
import { preserveReapEnvironment } from './container-reaper.ts';
import { commandAsync } from './core.ts';
import { pollUntilDeadline } from './readiness.ts';

export const integrationOwnerResetStatements = ['account', 'access', 'content', 'relay'].flatMap(
  (owner) => [
    `DROP DATABASE ${owner} WITH (FORCE)`,
    `CREATE DATABASE ${owner} WITH TEMPLATE ${owner}_tpl OWNER ${owner}`,
  ],
);

/** The work-scope proof graph. It keeps per-run repair cursors, label-copy
 * progress and retained title candidates, so a reset has to empty it too.
 * Raw update refuses that, and the maintenance dataset reset is what does. */
export const WORK_SCOPE_REPAIR_GRAPH = 'urn:rezics:projection:public-name-repair';

/** Empties every graph through the maintenance command, including the proof graph. */
export async function clearIntegrationDataset(fuseki: FusekiClient): Promise<void> {
  await fuseki.resetDataset();
}

/** A reset that fails while the stack is broken is a harness failure. It does
 * not fail the file that already passed, or the files the reset never reached. */
export function integrationResetHarnessFailure(input: {
  stack: string;
  pendingFiles: readonly string[];
  timedOut?: boolean;
}): { message: string; failedFiles: readonly string[] } {
  const pending = input.pendingFiles.length ? ` before ${input.pendingFiles.join(', ')}` : '';
  return {
    message: `integration reset ${input.timedOut ? 'timed out' : 'failed'} on stack ${input.stack}${pending}`,
    failedFiles: [],
  };
}

export function filesKeptAfterResetFailure(
  files: readonly string[],
  pendingFiles: readonly string[],
): string[] {
  const pending = new Set(pendingFiles);
  return files.filter((file) => !pending.has(file));
}

/** Called only between exited Bun commands, never alongside a test writer.
 * Migrated templates remain untouched. A fresh lineage and object directory
 * keep graph receipts, SQL authority and immutable bytes from crossing files. */
async function resetOwners(compose: Record<string, string>) {
  const db = new Client({
    connectionString: `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`,
  });
  await db.connect();
  try {
    for (const sql of integrationOwnerResetStatements) await db.query(sql);
  } finally {
    await db.end();
  }
}

async function resetGraph(
  apps: Record<string, string>,
  lineage: { dataEpoch: string; routingEpoch: string },
) {
  const fuseki = new FusekiClient(
    apps.FUSEKI_URL!,
    apps.FUSEKI_MAINTENANCE_TOKEN,
    apps.FUSEKI_COMMAND_TOKEN,
  );
  await clearIntegrationDataset(fuseki);
  await initializeFreshGraph(fuseki, lineage);
}

const S3_XML_NAMESPACE = 'http://s3.amazonaws.com/doc/2006-03-01/';
type ResetRequest = (url: string, init?: RequestInit) => Promise<Response>;

function resetXml(source: string, name: string): Element {
  let malformed = /<!DOCTYPE|<!ENTITY/i.test(source);
  const root = new DOMParser({ onError: () => { malformed = true; } })
    .parseFromString(source, 'application/xml').documentElement;
  if (malformed || !root || root.localName !== name || root.namespaceURI !== S3_XML_NAMESPACE)
    throw new Error('RustFS reset response is malformed');
  return root;
}

function xmlText(root: Element, name: string): string {
  const nodes = root.getElementsByTagNameNS(S3_XML_NAMESPACE, name);
  if (nodes.length !== 1) throw new Error('RustFS reset response is malformed');
  return nodes.item(0)!.textContent ?? '';
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;');
}

/** Drain the entire QA bucket, including retention namespaces outside Work.
 * Re-listing the first page after each delete both avoids mutable pagination
 * cursors and proves progress; a retained key makes the stack unusable. */
export async function clearIntegrationBucket(apps: Record<string, string>, request?: ResetRequest): Promise<void> {
  const signer = new AwsClient({ accessKeyId: apps.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: apps.MAIN_S3_SECRET_KEY!, region: apps.MAIN_S3_REGION ?? 'us-east-1',
    service: 's3', retries: 0 });
  const fetchBucket: ResetRequest = request ?? ((url, init) => signer.fetch(url, init));
  const bucket = apps.MAIN_S3_BUCKET!;
  const bucketUrl = `${new URL(apps.MAIN_S3_ENDPOINT!).origin}/${encodeURIComponent(bucket)}`;
  const checked = async (url: string, init?: RequestInit) => {
    const response = await fetchBucket(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`RustFS reset failed (${response.status})`);
    return response;
  };
  // Files that never use object storage may leave the bucket uncreated.
  const created = await fetchBucket(bucketUrl, { method: 'PUT', signal: AbortSignal.timeout(30_000) });
  await created.arrayBuffer();
  if (!created.ok && created.status !== 409) throw new Error(`RustFS reset failed (${created.status})`);
  const versioning = resetXml(await (await checked(`${bucketUrl}?versioning`)).text(), 'VersioningConfiguration');
  if (versioning.getElementsByTagNameNS(S3_XML_NAMESPACE, 'Status').length)
    throw new Error('RustFS reset cannot verify a versioned QA bucket');
  let previous = new Set<string>();
  while (true) {
    const listing = resetXml(await (await checked(`${bucketUrl}?list-type=2&max-keys=1000&encoding-type=url`)).text(), 'ListBucketResult');
    if (xmlText(listing, 'Name') !== bucket || xmlText(listing, 'EncodingType') !== 'url')
      throw new Error('RustFS reset listing does not match its bucket');
    const truncated = xmlText(listing, 'IsTruncated');
    const contents = listing.getElementsByTagNameNS(S3_XML_NAMESPACE, 'Contents');
    const keys = Array.from({ length: contents.length }, (_, index) =>
      decodeURIComponent(xmlText(contents.item(index)!, 'Key')));
    if (!['true', 'false'].includes(truncated) || xmlText(listing, 'KeyCount') !== String(keys.length)
      || keys.length > 1000 || new Set(keys).size !== keys.length || (truncated === 'true' && !keys.length))
      throw new Error('RustFS reset listing is incomplete');
    if (!keys.length) return;
    if (keys.some(key => previous.has(key))) throw new Error('RustFS reset left objects in the QA bucket');
    const body = `<Delete xmlns="${S3_XML_NAMESPACE}">${keys.map(key => `<Object><Key>${escapeXml(key)}</Key></Object>`).join('')}<Quiet>true</Quiet></Delete>`;
    const deleted = resetXml(await (await checked(`${bucketUrl}?delete`, {
      method: 'POST', body, headers: { 'content-type': 'application/xml',
        'content-md5': createHash('md5').update(body).digest('base64') },
    })).text(), 'DeleteResult');
    // S3 can return HTTP 200 with an individual denied deletion.
    if (deleted.getElementsByTagNameNS(S3_XML_NAMESPACE, 'Error').length)
      throw new Error('RustFS reset could not delete every object');
    previous = new Set(keys);
  }
}

export async function clearIntegrationMailbox(compose: Record<string, string>, request: ResetRequest = fetch): Promise<void> {
  if (!/^\d+$/.test(compose.MAILPIT_HTTP_PORT ?? '')) throw new Error('Mailpit reset needs its QA HTTP port');
  const url = `http://127.0.0.1:${compose.MAILPIT_HTTP_PORT}/api/v1/messages`;
  const deleted = await request(url, { method: 'DELETE', body: '{}',
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
  await deleted.arrayBuffer();
  if (!deleted.ok) throw new Error(`Mailpit reset failed (${deleted.status})`);
  const verified = await request(`${url}?limit=1`, { signal: AbortSignal.timeout(30_000) });
  if (!verified.ok) throw new Error(`Mailpit reset verification failed (${verified.status})`);
  const inbox = await verified.json() as { total?: unknown; messages?: unknown };
  if (!inbox || inbox.total !== 0 || !Array.isArray(inbox.messages) || inbox.messages.length !== 0)
    throw new Error('Mailpit reset could not verify an empty mailbox');
}

export async function resetIntegrationState(
  apps: Record<string, string>,
  compose: Record<string, string>,
  dependencies = { owners: resetOwners, graph: resetGraph, objects: clearIntegrationBucket, mail: clearIntegrationMailbox },
): Promise<Record<string, string>> {
  const lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
  await dependencies.owners(compose);
  await dependencies.graph(apps, lineage);
  await dependencies.objects(apps);
  await dependencies.mail(compose);
  const objects = apps.MAIN_OBJECT_DIRECTORY!;
  for (const directory of [objects, apps.MAIN_CANDIDATE_DIRECTORY].filter((path): path is string =>
    Boolean(path),
  )) {
    rmSync(directory, { recursive: true, force: true });
  }
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  return {
    ...apps,
    MAIN_DATA_EPOCH: lineage.dataEpoch,
    MAIN_ROUTING_EPOCH: lineage.routingEpoch,
    MAIN_OBJECT_DIRECTORY: objects,
  };
}

/** Only after the test command exits: deleting quads leaves TDB2 pages on
 * tmpfs, charged to Fuseki's memory limit across leases. Restarting this one
 * disposable service remounts its tmpfs before the fresh graph is bootstrapped.
 * Persistent stacks retain their physical data and use the logical reset. */
async function reclaimIntegrationGraphStorage(
  apps: Record<string, string>, compose: Record<string, string>, composePath: string,
): Promise<void> {
  if (compose.REZICS_STACK_PROFILE !== 'qa' || compose.REZICS_STACK_STORAGE !== 'tmpfs') return;
  const project = basename(dirname(resolve(composePath)));
  if (!/^rezics-qa-[a-z0-9-]+$/.test(project)) throw new Error('Invalid disposable QA stack directory');
  const restarted = await commandAsync(resolve(import.meta.dir, '../..'), 'docker',
    ['restart', '--time', '30', `${project}-fuseki-1`], 45_000, preserveReapEnvironment(process.env));
  if (!restarted.ok) throw new Error(`Fuseki storage reset failed: ${restarted.output}`);
  const ping = new URL('/$/ping', apps.FUSEKI_URL!).href;
  const ready = await pollUntilDeadline(async remainingMs => {
    try { return await fetch(ping, { signal: AbortSignal.timeout(Math.min(2_000, remainingMs)) }); }
    catch { return false; }
  }, Date.now() + 60_000);
  if (!ready) throw new Error('Fuseki did not become ready after its storage reset');
}

if (import.meta.main) {
  const appsPath = process.argv[2]!;
  const composePath = process.argv[3]!;
  const apps = readEnv(appsPath);
  const compose = readEnv(composePath);
  await reclaimIntegrationGraphStorage(apps, compose, composePath);
  const next = await resetIntegrationState(apps, compose);
  replacePrivate(appsPath, next);
  replacePrivate(composePath, {
    ...readEnv(composePath),
    MAIN_DATA_EPOCH: next.MAIN_DATA_EPOCH!,
    MAIN_ROUTING_EPOCH: next.MAIN_ROUTING_EPOCH!,
  });
}
