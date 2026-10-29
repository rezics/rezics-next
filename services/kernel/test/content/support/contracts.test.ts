import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { ContentThreadDriver, Persona, WriteOptions } from '../../../../../specs/content-thread-driver';
import type { ContentDisclosureDriver } from '../../../../../specs/content-disclosure-driver';
import type { ContentMediaDriver } from '../../../../../specs/content-media-driver';
import type { Access, AccountActor, ActionCatalogue, Actor } from '../../../src/request/access.ts';
import type { Kernel } from '../../../src/http/kernel.ts';
import type { KeyRing } from '../../../src/tokens/seal.ts';
import { createContentSystem } from './system.ts';
import type {
  ContentActors,
  ContentAuthClient,
  ContentCredential,
  ContentSystem,
  ContentSystemOptions,
} from './system.ts';
import { observeSql } from './sql-observer.ts';
import type { SqlBarrier, SqlBoundary, SqlExecution, SqlFaultHook, SqlMatch, SqlObserver } from './sql-observer.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function same<T extends true>(..._proof: T[]): void {}

// Checked by tsc, never invoked: factory implementations may own real resources.
function fixtureContracts(): void {
  same<Equal<typeof createContentSystem, (options: ContentSystemOptions) => Promise<ContentSystem>>>();
  same<Equal<ContentSystemOptions, { readonly databaseUrl: string; readonly namespace?: string }>>();
  same<Equal<ContentCredential, { readonly bearer: string; readonly actor: AccountActor }>>();
  same<Equal<Actor, AccountActor | { kind: 'anonymous' }>>();
  same<
    Equal<Access['authenticate'], (token: string, context: { pool: Pool; deadline: number }) => Promise<AccountActor>>
  >();
  same<
    Equal<
      ContentActors,
      {
        readonly anonymous: null;
        readonly author: ContentCredential;
        readonly other: ContentCredential;
        readonly moderator: ContentCredential;
        readonly suspended: ContentCredential;
        readonly worker: ContentCredential;
        readonly otherWorker: ContentCredential;
      }
    >
  >();
  same<Equal<ContentAuthClient, { readonly id: string; readonly kind: 'first-party' | 'confidential' }>>();
  same<Equal<ContentSystem['auth']['ordinaryScopes'], readonly string[]>>();
  same<
    Equal<
      ContentSystem,
      {
        readonly database: {
          readonly pool: Pool;
          readonly admin: Pool;
          readonly authPool: Pool;
          readonly authAdmin: Pool;
        };
        readonly kernel: Kernel;
        readonly routeKey: Uint8Array;
        readonly tokenKeys: KeyRing;
        readonly actors: ContentActors;
        readonly auth: {
          readonly ordinaryClient: ContentAuthClient;
          readonly ordinaryScopes: readonly string[];
          readonly websiteClient: ContentAuthClient;
          issue(input: {
            readonly accountId: string;
            readonly clientId: string;
            readonly scopes: readonly string[];
            readonly requestedBy?: string;
          }): Promise<ContentCredential>;
          refresh(input: { readonly refreshToken: string }): Promise<ContentCredential>;
        };
        readonly access: Access;
        readonly actions: ActionCatalogue;
        readonly clock: {
          setCommandTime(instant: string): Promise<void>;
          setCursorVerificationTime(instant: string): Promise<void>;
        };
        readonly transport: {
          capture(request: Request): Promise<{ readonly request: Request; readonly response: Response }>;
        };
        close(): Promise<void>;
      }
    >
  >();
  same<
    Equal<
      AccountActor,
      {
        kind: 'account';
        accountId: string;
        clientId: string;
        scopes: readonly string[];
        requestedBy: string | null;
        authnEpoch: number;
      }
    >
  >();
  same<Equal<Persona, { id: string; bearer: string }>>();
  same<Equal<WriteOptions, { actor: Persona | null; key: string; session?: string }>>();
  same<
    Equal<
      ContentThreadDriver['session'],
      (response: Response, actor: Persona) => Promise<{ token: string; partitions: number[] }>
    >
  >();
}

function observerContracts(): void {
  same<Equal<typeof observeSql, (pool: Pool) => SqlObserver>>();
  same<
    Equal<
      SqlExecution,
      {
        readonly statement: string;
        readonly parameters: readonly unknown[];
        readonly connectionId: number;
        readonly executedAt: string;
      }
    >
  >();
  same<Equal<SqlMatch, { readonly statement: string; readonly occurrence?: number }>>();
  same<Equal<SqlBoundary, 'before' | 'after'>>();
  same<Equal<SqlFaultHook, { readonly match: SqlMatch; readonly boundary: SqlBoundary; readonly error: Error }>>();
  same<
    Equal<
      SqlBarrier,
      {
        readonly match: SqlMatch;
        readonly boundary: SqlBoundary;
        readonly entered: Promise<SqlExecution>;
        release(): void;
      }
    >
  >();
  same<
    Equal<
      SqlObserver,
      {
        readonly records: readonly SqlExecution[];
        armFault(hook: SqlFaultHook): void;
        hold(match: SqlMatch, boundary: SqlBoundary): SqlBarrier;
        close(): Promise<void>;
      }
    >
  >();
}

// Thin driver consumers retain real wire objects, credentials and SQL evidence.
// No driver or product behavior is implemented by these compile-time witnesses.
async function driverConsumers(
  system: ContentSystem,
  thread: ContentThreadDriver,
  disclosure: ContentDisclosureDriver,
  media: ContentMediaDriver,
  request: Request,
  requestId: string,
  threadId: string,
  postId: string,
  revisionId: string,
): Promise<void> {
  const observer: SqlObserver = observeSql(system.database.pool);
  const persona: Persona = { id: system.actors.author.actor.accountId, bearer: system.actors.author.bearer };
  const wire: { readonly request: Request; readonly response: Response } = await system.transport.capture(request);
  const response: Response = await system.kernel.handle(wire.request);
  const session: { token: string; partitions: number[] } = await thread.session(response, persona);
  const options: WriteOptions = {
    actor: persona,
    key: requestId,
    session: session.token,
  };
  const threadReply = await thread.readItem(threadId, postId, options.actor, revisionId);
  const disclosureReply = await disclosure.read('author', { kind: 'thread', id: threadId });
  const responses: readonly Response[] = [threadReply.response, disclosureReply.response];
  const credential: ContentCredential = await system.auth.issue({
    accountId: system.actors.worker.actor.accountId,
    clientId: system.auth.websiteClient.id,
    scopes: system.actors.worker.actor.scopes,
  });
  const evidence: Awaited<ReturnType<ContentMediaDriver['authenticationEvidence']>> =
    await media.authenticationEvidence('worker', requestId);
  const refreshed: ContentCredential = await system.auth.refresh({ refreshToken: requestId });
  await system.clock.setCommandTime('2026-01-01T00:00:00Z');
  await system.clock.setCursorVerificationTime('2026-01-01T00:00:00Z');
  const scopes: readonly string[] = credential.actor.scopes;
  await disclosure.read('moderator', { kind: 'post', id: postId }, revisionId);
  const barrier: SqlBarrier = observer.hold({ statement: 'COMMIT', occurrence: 1 }, 'before');
  const entered: SqlExecution = await barrier.entered;
  observer.armFault({ match: { statement: entered.statement }, boundary: 'after', error: new Error('query fault') });
  barrier.release();
  const records: readonly SqlExecution[] = observer.records;
  void [responses, evidence, records, scopes, refreshed];
  await observer.close();
  await system.close();
}
void [fixtureContracts, observerContracts, driverConsumers];

test('shared fixture and observer factories are exported', () => {
  expect(typeof createContentSystem).toBe('function');
  expect(typeof observeSql).toBe('function');
});
