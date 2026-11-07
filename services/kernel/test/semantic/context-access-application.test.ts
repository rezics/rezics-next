import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { composeSemanticContext } from '../../src/composition/semantic-context.ts';
import { contextAccess, type ContextAccessPort } from '../../src/semantic/context-access-port.ts';
import { createContextApplication } from '../../src/semantic/context-application.ts';

function fakePort(calls: string[]): ContextAccessPort {
  return {
    deadlineClient: (client) => client,
    requireDeadline: () => {
      calls.push('requireDeadline');
    },
    withReadTransaction: async (_pool, read) => read({ query: async () => ({ rows: [], rowCount: 0 }) } as never),
    prepareReadDecisions: async () => {
      calls.push('prepareReadDecisions');
      return {
        decide: async () => {
          calls.push('decide');
          return {};
        },
      };
    },
    viewerActionReadTime: () => {
      calls.push('viewerActionReadTime');
      throw new Error('fake has no read time');
    },
    resourceAuthorization: () => {
      calls.push('resourceAuthorization');
      throw new Error('fake has no authorization');
    },
    initializeResourceGrants: async () => {
      calls.push('initializeResourceGrants');
    },
    createPublicEligibility: () => {
      calls.push('createPublicEligibility');
      return {};
    },
    readAccount: async () => {
      calls.push('readAccount');
      return { state: 'active', fenced: false };
    },
    requestInvalid: () => {
      calls.push('requestInvalid');
      return new Error('invalid_request');
    },
    notFound: () => {
      calls.push('notFound');
      return new Error('not_found');
    },
    lifecycleDenied: () => {
      calls.push('lifecycleDenied');
      return new Error('denied');
    },
    refreshErasureSourceRecord: async () => {
      calls.push('refreshErasureSourceRecord');
    },
    readSourceDisposition: async () => {
      calls.push('readSourceDisposition');
      return null;
    },
    recordSourceDisposition: () => {
      calls.push('recordSourceDisposition');
    },
    recordSourceCommit: async () => {
      calls.push('recordSourceCommit');
    },
  };
}

test('Context application lists through the bound Access port without native Access', async () => {
  const calls: string[] = [];
  const application = createContextApplication(fakePort(calls));
  await expect(
    application.list(
      {
        pool: {} as Pool,
        access: {},
        tokens: { current: 1, keys: new Map([[1, new Uint8Array(32)]]) },
      },
      { actor: { kind: 'anonymous' }, deadline: Date.now() + 1_000, query: '\0' },
    ),
  ).rejects.toThrow('invalid_request');
  expect(calls).toContain('requestInvalid');
  expect(
    await application.authorizedMetadata(
      { pool: {} as Pool, access: {} },
      { ids: [], actor: { kind: 'anonymous' }, deadline: Date.now() + 1_000 },
    ),
  ).toEqual([]);
});

test('ordinary composition binds native Context Access and constructs the live directory', () => {
  const application = composeSemanticContext();
  expect(contextAccess()).toBe(application.access);
  expect(typeof application.createDirectory).toBe('function');
  expect(typeof application.enrollRoleProvenance).toBe('function');
  expect(typeof application.changeLifecycle).toBe('function');
});
