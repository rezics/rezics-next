import type { Pool } from 'pg';
import type { Access, AccountActor, ActionCatalogue } from '../../../src/request/access.ts';
import type { Kernel } from '../../../src/http/kernel.ts';
import type { KeyRing } from '../../../src/tokens/seal.ts';

export type ContentAccountState = 'active' | 'suspended';

/** A credential and identity observed by the production Access verifier. */
export interface ContentCredential {
  readonly bearer: string;
  readonly actor: AccountActor;
}

export interface ContentActors {
  readonly anonymous: null;
  readonly author: ContentCredential;
  readonly other: ContentCredential;
  readonly moderator: ContentCredential;
  readonly suspended: ContentCredential;
  readonly worker: ContentCredential;
  readonly otherWorker: ContentCredential;
}

export interface ContentAuthClient {
  readonly id: string;
  readonly kind: 'first-party' | 'confidential';
}

export interface ContentSystemOptions {
  /** Migrated source database used as the template for an isolated fixture database. */
  readonly databaseUrl: string;
}

export interface ContentSystem {
  readonly database: {
    /** Isolated migrated application database used by Kernel and Access. */
    readonly pool: Pool;
    /** Administrative connection used only for fixture namespace lifecycle/setup. */
    readonly admin: Pool;
    /** Isolated migrated Auth database. */
    readonly authPool: Pool;
    /** Administrative connection for Auth database lifecycle/setup. */
    readonly authAdmin: Pool;
  };
  readonly kernel: Kernel;
  readonly routeKey: Uint8Array;
  readonly tokenKeys: KeyRing;
  readonly actors: ContentActors;
  readonly auth: {
    readonly ordinaryClient: ContentAuthClient;
    readonly websiteClient: ContentAuthClient;
    /** Obtain a real Auth-issued token for a provisioned account and registered client. */
    issue(input: {
      readonly accountId: string;
      readonly clientId: string;
      readonly scopes: readonly string[];
      readonly requestedBy?: string;
    }): Promise<ContentCredential>;
    /** Refresh through the real Auth service while retaining the registered client identity. */
    refresh(input: { readonly refreshToken: string }): Promise<ContentCredential>;
  };
  readonly access: Access;
  /** Catalogue derived from the routes mounted on this real Kernel. */
  readonly actions: ActionCatalogue;
  readonly clock: {
    setCommandTime(instant: string): Promise<void>;
    setCursorVerificationTime(instant: string): Promise<void>;
  };
  readonly transport: {
    /** Route an exact Request through Kernel.handle and retain both wire objects. */
    capture(request: Request): Promise<{ readonly request: Request; readonly response: Response }>;
  };
  close(): Promise<void>;
}

/** The implementation is intentionally pending; this port performs no setup yet. */
export function createContentSystem(_options: ContentSystemOptions): Promise<ContentSystem> {
  throw new Error('createContentSystem is not implemented');
}
