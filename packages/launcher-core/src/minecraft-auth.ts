import type { MinecraftAccount, MinecraftAccounts, MinecraftSignInStatus } from '@rezics/launcher-contract';
import { rm } from 'node:fs/promises';
import * as v from 'valibot';
import {
  type AuthorizedProfile,
  AuthFailure,
  MinecraftAuthProvider,
  minecraftIdentity,
  privateToken,
} from './minecraft-auth-provider.ts';
import { Locks, readJson, writeJson } from './storage.ts';

const expiry = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const savedProfile = v.object({
  profile: minecraftIdentity,
  token: v.optional(privateToken),
  expiresAt: v.optional(expiry),
  refresh: v.optional(privateToken),
});
const currentVault = v.object({
  version: v.literal(2),
  clientId: v.nullable(v.string()),
  activeId: v.nullable(v.string()),
  profiles: v.array(savedProfile),
});
const legacyVault = v.object({
  ...savedProfile.entries,
  clientId: v.string(),
  token: privateToken,
  expiresAt: expiry,
});
const envelope = v.object({ encrypted: v.string() });

export type SecretStorage = { encrypt(plain: string): string; decrypt(encrypted: string): string };
type Entry = v.InferOutput<typeof savedProfile>;
type Vault = { activeId: string | null; profiles: Map<string, Entry> };
type LaunchIdentity = { profile: MinecraftAccount; token: string };
type Flow = {
  cancel: AbortController;
  accountId: string | undefined;
};
type Refresh = { entry: Entry; cancel: AbortController; done: Promise<LaunchIdentity> };

function launchIdentity(entry: Entry): LaunchIdentity | undefined {
  if (entry.token && entry.expiresAt && entry.expiresAt > Date.now()) {
    return { profile: { ...entry.profile }, token: entry.token };
  }
}

export class MinecraftAuth {
  private flow: Flow | undefined;
  private signIn: MinecraftSignInStatus = { state: 'idle' };
  private readonly signInObservers = new Set<() => void>();
  private vault: Vault | undefined;
  private readonly locks = new Locks();
  private readonly refreshing = new Map<string, Refresh>();
  private readonly provider: MinecraftAuthProvider;

  constructor(
    private readonly clientId: string | undefined,
    private readonly file: string,
    private readonly secretStorage?: SecretStorage,
    fetcher = fetch,
  ) {
    this.provider = new MinecraftAuthProvider(clientId, fetcher);
  }

  private async load(): Promise<Vault> {
    if (this.vault) return this.vault;
    const empty = { activeId: null, profiles: new Map<string, Entry>() };
    if (!this.secretStorage) return (this.vault = empty);
    const saved = await readJson<unknown>(this.file).catch((error: unknown) => {
      if (!(error instanceof SyntaxError)) throw new Error('Minecraft could not read the protected profiles.');
    });
    const wrapped = v.safeParse(envelope, saved);
    if (!wrapped.success) return (this.vault = empty);

    let plain: unknown;
    try {
      plain = JSON.parse(this.secretStorage.decrypt(wrapped.output.encrypted));
    } catch {
      // A different OS user or protected storage key can make the encrypted file unreadable.
      return (this.vault = empty);
    }

    const current = v.safeParse(currentVault, plain);
    if (current.success) {
      const { activeId, profiles, clientId } = current.output;
      const entries = new Map(
        profiles.map((entry) => [entry.profile.id, clientId === this.clientId ? entry : { profile: entry.profile }]),
      );
      return (this.vault = { activeId: activeId && entries.has(activeId) ? activeId : null, profiles: entries });
    }

    const legacy = v.safeParse(legacyVault, plain);
    if (!legacy.success) return (this.vault = empty);
    const { clientId, ...entry } = legacy.output;
    const compatible = clientId === this.clientId;
    const migrated = {
      activeId: entry.profile.id,
      profiles: new Map([[entry.profile.id, compatible ? entry : { profile: entry.profile }]]),
    };
    this.vault = migrated;
    if (compatible) await this.store(migrated).catch(() => {});
    return migrated;
  }

  private async store(vault: Vault) {
    if (this.secretStorage) {
      try {
        if (vault.profiles.size === 0) await rm(this.file, { force: true });
        else {
          const state = {
            version: 2,
            clientId: this.clientId ?? null,
            activeId: vault.activeId,
            profiles: [...vault.profiles.values()],
          };
          await writeJson(this.file, { encrypted: this.secretStorage.encrypt(JSON.stringify(state)) });
        }
      } catch {
        throw new Error('Minecraft could not update the protected profile store.');
      }
    }
    this.vault = vault;
  }

  private view(vault: Vault): MinecraftAccounts {
    return {
      activeId: vault.activeId,
      persistent: this.secretStorage !== undefined,
      profiles: [...vault.profiles.values()].map((entry) => ({
        ...entry.profile,
        state: launchIdentity(entry) || entry.refresh ? 'ready' : 'needs-sign-in',
      })),
    };
  }

  accounts(): Promise<MinecraftAccounts> {
    return this.locks.run('credentials', async () => this.view(await this.load()));
  }

  account(): Promise<MinecraftAccount | null> {
    return this.locks.run('credentials', async () => {
      const vault = await this.load();
      const entry = vault.activeId && vault.profiles.get(vault.activeId);
      return entry ? { ...entry.profile } : null;
    });
  }

  select(id: string): Promise<MinecraftAccounts> {
    return this.locks.run('credentials', async () => {
      const vault = await this.load();
      if (!vault.profiles.has(id)) throw new Error('Select a saved Minecraft profile.');
      const next = { ...vault, activeId: id };
      if (vault.activeId !== id) await this.store(next);
      return this.view(next);
    });
  }

  private async forgetFrom(vault: Vault, id: string) {
    if (!vault.profiles.has(id)) return vault;
    const next = { activeId: vault.activeId === id ? null : vault.activeId, profiles: new Map(vault.profiles) };
    next.profiles.delete(id);
    await this.store(next);
    this.refreshing.get(id)?.cancel.abort();
    return next;
  }

  forget(id: string): Promise<MinecraftAccounts> {
    return this.locks.run('credentials', async () => {
      if (this.flow?.accountId === id) this.cancelFlow();
      const vault = await this.forgetFrom(await this.load(), id);
      if (this.signIn.state === 'signed-in') this.setSignIn({ state: 'idle' });
      return this.view(vault);
    });
  }

  subscribeSignIn(listener: () => void) {
    this.signInObservers.add(listener);
    return () => {
      this.signInObservers.delete(listener);
    };
  }

  readSignIn(): MinecraftSignInStatus {
    return this.signIn;
  }

  private setSignIn(status: MinecraftSignInStatus) {
    this.signIn = status;
    for (const listener of this.signInObservers) {
      try {
        listener();
      } catch {
        // A window closing during notification does not interrupt sign-in.
      }
    }
  }

  private cancelFlow() {
    if (this.signIn.state === 'saving') return;
    this.flow?.cancel.abort(new AuthFailure('cancelled'));
    this.flow = undefined;
    this.setSignIn({ state: 'idle' });
  }

  async cancelSignIn(): Promise<void> {
    this.cancelFlow();
  }

  async begin(accountId?: string): Promise<void> {
    if (this.flow) throw new Error('A Microsoft sign-in is already in progress.');
    const flow: Flow = { accountId, cancel: new AbortController() };
    this.flow = flow;
    this.setSignIn({ state: 'requesting' });
    try {
      if (accountId !== undefined) {
        await this.locks.run('credentials', async () => {
          if (!(await this.load()).profiles.has(accountId))
            throw new Error('Select a saved Minecraft profile to reconnect.');
        });
      }
      const { signal } = flow.cancel;
      signal.throwIfAborted();
      const device = await this.provider.begin(signal);
      signal.throwIfAborted();
      const { url, code, expiresAt } = device;
      this.setSignIn({ state: 'waiting', device: { url, code, expiresAt } });
      void this.finish(flow, device).catch((error: unknown) => this.failFlow(flow, error));
    } catch (error) {
      this.failFlow(flow, error);
    }
  }

  private endFlow(flow: Flow, status: MinecraftSignInStatus) {
    if (this.flow !== flow) return;
    this.flow = undefined;
    this.setSignIn(status);
  }

  private failFlow(flow: Flow, error: unknown) {
    const message = error instanceof Error ? error.message : 'Microsoft sign-in could not be completed. Try again.';
    this.endFlow(flow, { state: 'failed', message: message.slice(0, 320) });
  }

  private async finish(flow: Flow, device: Awaited<ReturnType<MinecraftAuthProvider['begin']>>) {
    const entry = await this.provider.complete(device, flow.cancel.signal);
    return this.locks.run('credentials', async () => {
      const stored = await this.load();
      flow.cancel.signal.throwIfAborted();
      if (device.expiresAt <= Date.now()) throw new AuthFailure('expired');
      const id = entry.profile.id;
      if (flow.accountId !== undefined && (id !== flow.accountId || !stored.profiles.has(flow.accountId))) {
        throw new Error('Sign in with the same Minecraft profile to reconnect this account.');
      }
      const activeId = flow.accountId === undefined ? id : stored.activeId;
      this.setSignIn({ state: 'saving' });
      await this.store({ activeId, profiles: new Map(stored.profiles).set(id, entry) });
      this.refreshing.get(id)?.cancel.abort();
      this.endFlow(flow, { state: 'signed-in' });
    });
  }

  async launchCredentials(id?: string): Promise<LaunchIdentity> {
    const selection = await this.locks.run('credentials', async () => {
      const vault = await this.load();
      const selected = id ?? vault.activeId;
      const entry = selected && vault.profiles.get(selected);
      if (!entry)
        throw new Error(
          id
            ? 'Reconnect or change the Minecraft profile for this instance.'
            : 'Select or sign in to a Minecraft profile before launching.',
        );
      const credentials = launchIdentity(entry);
      if (credentials) return { credentials };
      if (!entry.refresh) throw new AuthFailure('expired');

      const current = this.refreshing.get(entry.profile.id);
      if (current?.entry === entry) return { pending: current.done };
      const cancel = new AbortController();
      const work = { entry, cancel, done: this.refresh(entry, entry.refresh, cancel.signal) };
      this.refreshing.set(entry.profile.id, work);
      void work.done
        .finally(() => {
          if (this.refreshing.get(entry.profile.id) === work) this.refreshing.delete(entry.profile.id);
        })
        .catch(() => {});
      return { pending: work.done };
    });
    return selection.credentials ?? selection.pending;
  }

  private async refresh(entry: Entry, refresh: string, cancel: AbortSignal): Promise<LaunchIdentity> {
    const id = entry.profile.id;
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(40_000)]);
    let next: AuthorizedProfile;
    try {
      next = await this.provider.refresh(refresh, signal);
      if (next.profile.id !== id) throw new AuthFailure('denied');
    } catch (error) {
      if (cancel.aborted) throw new Error('The selected Minecraft profile changed. Select a profile and retry.');
      if (error instanceof AuthFailure && ['expired', 'denied', 'entitlement', 'profile'].includes(error.kind)) {
        await this.locks.run('credentials', async () => {
          const vault = await this.load();
          if (vault.profiles.get(id) === entry) {
            await this.store({ ...vault, profiles: new Map(vault.profiles).set(id, { profile: entry.profile }) });
          }
        });
      }
      throw error;
    }

    return this.locks.run('credentials', async () => {
      const vault = await this.load();
      if (cancel.aborted || vault.profiles.get(id) !== entry) {
        throw new Error('The selected Minecraft profile changed. Select a profile and retry.');
      }
      const credentials = launchIdentity(next);
      if (!credentials) throw new AuthFailure('expired');
      await this.store({ ...vault, profiles: new Map(vault.profiles).set(id, next) });
      return credentials;
    });
  }

  signOut(): Promise<void> {
    this.cancelFlow();
    return this.locks.run('credentials', async () => {
      const vault = await this.load();
      if (vault.activeId) await this.forgetFrom(vault, vault.activeId);
      if (this.signIn.state === 'signed-in') this.setSignIn({ state: 'idle' });
    });
  }
}
