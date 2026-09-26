import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import type { DeliveryProvider, ProviderLookup, ProviderResult, ProviderSend }
  from '../../../services/main/src/modules/notification/dispatcher.ts';

/**
 * In-stack fake external channel. It deduplicates by delivery id like a real
 * provider idempotency key and can lose the acknowledgement after accepting,
 * fail before accepting, reject, or become unreachable for lookups.
 */
export type FakeBehavior = 'accept' | 'lose-ack' | 'fail-before-accept' | 'transient' | 'permanent';

export class FakeDeliveryProvider implements DeliveryProvider {
  readonly name = 'fake';
  readonly calls = { send: 0, lookup: 0 };
  readonly accepted = new Map<string, { messageId: string; payload: Readonly<Record<string, string>>;
    requests: number }>();
  lookupDown = false;
  private readonly queue: FakeBehavior[] = [];

  next(...behaviors: FakeBehavior[]): void { this.queue.push(...behaviors); }

  async send(request: ProviderSend): Promise<ProviderResult> {
    this.calls.send++;
    const behavior = this.queue.shift() ?? 'accept';
    if (behavior === 'fail-before-accept') throw new Error('connection reset before provider accepted');
    if (behavior === 'transient') return { status: 'rejected', permanent: false, code: 'rate_limited' };
    if (behavior === 'permanent') return { status: 'rejected', permanent: true, code: 'invalid_recipient' };
    const prior = this.accepted.get(request.deliveryId);
    const message = prior ?? { messageId: `msg-${randomUUID()}`, payload: request.payload, requests: 0 };
    message.requests++;
    this.accepted.set(request.deliveryId, message);
    if (behavior === 'lose-ack') throw new Error('acknowledgement lost after provider accepted');
    return { status: 'accepted', messageId: message.messageId };
  }

  async lookup(deliveryId: string): Promise<ProviderLookup> {
    this.calls.lookup++;
    if (this.lookupDown) throw new Error('provider lookup unreachable');
    const message = this.accepted.get(deliveryId);
    return message ? { status: 'delivered', messageId: message.messageId } : { status: 'not_found' };
  }
}

export function signProviderEvent(secret: string, raw: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

type Owner = 'account' | 'access' | 'content' | 'relay';
const urlKey: Record<Owner, string> = { account: 'ACCOUNT_DATABASE_URL', access: 'ACCESS_DATABASE_URL',
  content: 'CONTENT_DATABASE_URL', relay: 'ACCOUNT_RELAY_DATABASE_URL' };

/** Isolated copies of the migrated QA owner templates for one test file. */
export async function cloneQaOwnerDatabases(runId: string, owners: readonly Owner[]): Promise<{
  urls: Record<Owner, string>;
  /** Point-in-time copy of an isolated owner database, as a restored backup. */
  snapshot: (owner: Owner, closeConnections: () => Promise<void>) => Promise<string>;
  close: () => Promise<void>;
}> {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) throw new Error('QA database clones require a valid run');
  const root = resolve(import.meta.dir, '../../..');
  const stackDir = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  const compose = readEnv(join(stackDir, 'compose.env'));
  const apps = readEnv(join(stackDir, 'apps.env'));
  const adminUrl = `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`;
  const suffix = randomBytes(6).toString('hex');
  const created: string[] = [];
  const urls = {} as Record<Owner, string>;
  const names = {} as Record<Owner, string>;
  const admin = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try { return await work(client); } finally { await client.end(); }
  };
  const urlFor = (owner: Owner, name: string) => {
    const url = new URL(apps[urlKey[owner]]!);
    url.pathname = `/${name}`;
    return url.toString();
  };
  try {
    await admin(async client => {
      for (const owner of owners) {
        const name = `qa_${suffix}_${owner}`;
        await client.query(`CREATE DATABASE ${name} WITH TEMPLATE ${owner}_tpl OWNER ${owner}`);
        created.push(name);
        names[owner] = name;
        urls[owner] = urlFor(owner, name);
      }
    });
  } catch (error) {
    await admin(async client => {
      for (const name of created.reverse()) await client.query(`DROP DATABASE ${name} WITH (FORCE)`);
    });
    throw error;
  }
  let snapshots = 0;
  return {
    urls,
    snapshot: async (owner, closeConnections) => {
      await closeConnections();
      const name = `qa_${suffix}_${owner}_s${++snapshots}`;
      await admin(client => client.query(`CREATE DATABASE ${name} WITH TEMPLATE ${names[owner]} OWNER ${owner}`));
      created.push(name);
      return urlFor(owner, name);
    },
    close: () => admin(async client => {
      for (const name of [...created].reverse()) await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }),
  };
}
