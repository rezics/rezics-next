import type { Pool, PoolClient, Notification as PgNotification } from 'pg';
import { NOTIFICATION_REALTIME_CHANNEL } from './store.ts';

export interface NotificationStreamHint {
  profile: 'notification-stream-hint-v1';
  generation: string;
  head: string;
}

type Listener = (hint: NotificationStreamHint) => void;

const principalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const generationPattern = /^[1-9][0-9]{0,18}$/;
const counterPattern = /^(0|[1-9][0-9]{0,18})$/;

/**
 * One Access LISTEN connection per Main process fans out minimal committed
 * cursor hints to that process's authenticated sockets. Notifications are
 * deliberately disposable; reconnecting clients compare the hint with their
 * cursor and retrieve every missing row from NotificationStore.
 */
export class NotificationRealtimeHub {
  private client: PoolClient | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  private stopping = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly pool: Pool, private readonly retryMs = 1_000) {
    if (!Number.isSafeInteger(retryMs) || retryMs < 1) throw new Error('retryMs must be positive');
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  subscribe(principalId: string, listener: Listener): () => void {
    if (!principalIdPattern.test(principalId)) throw new Error('invalid realtime recipient');
    const group = this.listeners.get(principalId) ?? new Set<Listener>();
    group.add(listener);
    this.listeners.set(principalId, group);
    return () => {
      group.delete(listener);
      if (!group.size) this.listeners.delete(principalId);
    };
  }

  private connect(): Promise<void> {
    if (this.stopping || this.client) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.openListener().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async openListener(): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      client.on('notification', (message: PgNotification) => this.receive(message));
      client.on('error', () => this.disconnected(client!));
      client.on('end', () => this.disconnected(client!));
      await client.query(`LISTEN ${NOTIFICATION_REALTIME_CHANNEL}`);
      if (this.stopping) {
        await client.query('UNLISTEN *');
        client.release();
        return;
      }
      this.client = client;
    } catch (error) {
      if (client) client.release(error instanceof Error ? error : true);
      this.scheduleReconnect();
      throw error;
    }
  }

  private receive(message: PgNotification): void {
    if (message.channel !== NOTIFICATION_REALTIME_CHANNEL || !message.payload) return;
    let value: { principalId?: unknown; generation?: unknown; head?: unknown };
    try { value = JSON.parse(message.payload) as typeof value; } catch { return; }
    if (typeof value.principalId !== 'string' || !principalIdPattern.test(value.principalId)
      || typeof value.generation !== 'string' || !generationPattern.test(value.generation)
      || typeof value.head !== 'string' || !counterPattern.test(value.head)) return;
    const hint: NotificationStreamHint = { profile: 'notification-stream-hint-v1',
      generation: value.generation, head: value.head };
    for (const listener of this.listeners.get(value.principalId) ?? []) {
      try { listener(hint); } catch { /* one closed socket cannot block another */ }
    }
  }

  private disconnected(client: PoolClient): void {
    if (this.client !== client) return;
    this.client = undefined;
    client.removeAllListeners('notification');
    client.removeAllListeners('error');
    client.removeAllListeners('end');
    client.release(true);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, this.retryMs);
    this.retry.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) {
      client.removeAllListeners('notification');
      client.removeAllListeners('error');
      client.removeAllListeners('end');
      try { await client.query('UNLISTEN *'); } finally { client.release(); }
    }
    this.listeners.clear();
  }
}
