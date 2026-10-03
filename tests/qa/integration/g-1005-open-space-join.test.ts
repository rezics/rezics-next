import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { bootstrapWebAuth, upgradeWebClient } from '../../../scripts/dev/web-auth-bootstrap.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import {
  AccountAssertionDenied,
  AccountAssertionInsufficientScope,
} from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessMemberships } from '../../../services/main/src/modules/access/memberships.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessRealmJoining } from '../../../services/main/src/modules/access/realm-management-joining.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { RealmJoinRequests } from '../../../services/main/src/modules/realm-admin/join-requests.ts';
import { startMediaStack } from './media-support.ts';

const short = (value: string) => value.slice(-36);
interface Policy {
  policyRevision: string;
  termsRevision: string;
  membershipGeneration: string;
  state: 'absent' | 'joined' | 'left';
  open: boolean;
  selfJoin: boolean;
}
interface Joined {
  membershipId: string;
  membershipGeneration: string;
  replayed: boolean;
}
interface Membership {
  membershipId: string;
  generation: string;
  realm: string;
  space: string;
  member: string;
  following: boolean;
  level: string;
  source: string;
}
interface Follow {
  id: string;
  level: string;
  source: string;
}
interface Page<T> {
  items: T[];
  complete: boolean;
}

for (const identity of ['provisioned', 'local-fixture'] as const)
  test(`G-1005: ${identity} person joins an open Space in one public command, leaves and rejoins`, async () => {
    const s = await startMediaStack('g-1005-open-join');
    let authDirectory: string | undefined;
    try {
      const owner = await s.member('owner'),
        newcomer = await s.member('newcomer');
      let fixtureAgent: string | undefined;
      if (identity === 'local-fixture') {
        const auth = await bootstrapWebAuth({
          runId: Bun.env.REZICS_QA_RUN_ID!,
          redirectUris: ['http://localhost:3000/auth/callback'],
        });
        authDirectory = dirname(auth.publicConfigPath);
        const saved = JSON.parse(readFileSync(auth.privateConfigPath, 'utf8')) as {
          member: { id: string };
        };
        const config = JSON.parse(readFileSync(auth.publicConfigPath, 'utf8')) as {
          issuer: string;
        };
        newcomer.principal = { issuer: config.issuer, subject: saved.member.id };
        fixtureAgent = auth.actingSubject;
        // Existing stacks take the upgrade path even when OAuth is current.
        expect(await upgradeWebClient({ runId: Bun.env.REZICS_QA_RUN_ID! })).toBe(false);
      }
      const people = [owner, newcomer];
      const app = createMainApp(s.fuseki, {
        environment: s.env,
        access: s.access,
        agentProvisioning: new AgentProvisioning(s.accessPool, s.env),
        realmAdmin: new AccessRealmManagement(s.accessPool),
        realmJoining: new AccessRealmJoining(s.accessPool, s.env),
        realmJoinRequests: new RealmJoinRequests(s.accessPool, s.env),
        memberships: new AccessMemberships(s.accessPool),
        follows: new FollowsStore(s.accessPool),
        account: {
          verify: async (request, scopes = []) => {
            const person = people.find(
              (member) => request.headers.get('authorization') === `Bearer ${member.token}`,
            );
            if (!person) throw new AccountAssertionDenied('Authentication required');
            if (person === newcomer && scopes.includes('access:manage')) {
              throw new AccountAssertionInsufficientScope(
                'The member has only recipient consent scope',
              );
            }
            const principal = { ...person.principal, emailVerified: true };
            return { ...principal, currentAssertion: async () => principal };
          },
        },
      });
      const call = (
        person: typeof owner,
        method: string,
        path: string,
        body?: object,
        key = randomUUID(),
      ) =>
        app.handle(
          new Request(`http://main.local${path}`, {
            method,
            headers: {
              authorization: `Bearer ${person.token}`,
              'idempotency-key': key,
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        );
      const json = async <T>(pending: Response | Promise<Response>, status = 200): Promise<T> => {
        const response = await pending;
        const body = await response.text();
        expect({
          status: response.status,
          ...(response.status === status ? {} : { body }),
        }).toEqual({ status });
        return JSON.parse(body) as T;
      };
      const provision = async (person: typeof owner) =>
        (
          await json<{ agent: string }>(
            await call(person, 'POST', '/v1/agents', {
              profile: 'agent-provision-v1',
              kind: 'person',
              displayName: person.name,
            }),
            201,
          )
        ).agent;
      const ownerAgent = await provision(owner),
        memberAgent = fixtureAgent ?? (await provision(newcomer));
      const { realm, space } = await json<{ realm: string; space: string }>(
        await call(owner, 'POST', '/v1/spaces', {
          profile: 'space-realm-v1',
          name: 'G-1005 open community',
          language: 'en',
          capabilities: ['realm'],
          actingSubject: ownerAgent,
        }),
        201,
      );
      const root = `/v1/realms/${short(realm)}`,
        settingsPath = `/v1/spaces/${short(space)}/settings`;
      await json(await call(owner, 'POST', `${root}/management`, { actingSubject: ownerAgent }));
      const settings = () =>
        json<{ generation: string; settings: object }>(
          call(owner, 'GET', `${settingsPath}?actingSubject=${encodeURIComponent(ownerAgent)}`),
        );
      const setAdmission = async (
        admission: 'open' | 'request' | 'invitation',
        visibility = 'public',
      ) => {
        const current = await settings();
        await json(
          await call(owner, 'PUT', settingsPath, {
            actingSubject: ownerAgent,
            expectedGeneration: current.generation,
            reason: 'Exercise the configured admission workflow',
            settings: { ...current.settings, visibility, admission },
          }),
          201,
        );
      };
      const joining = () =>
        json<Policy>(
          call(newcomer, 'GET', `${root}/joining?actingSubject=${encodeURIComponent(memberAgent)}`),
        );
      const inventory = async <T>(kind: 'follows' | 'memberships') =>
        (
          await json<Page<T>>(
            await call(
              newcomer,
              'GET',
              `/v1/me/${kind}?actingSubject=${encodeURIComponent(memberAgent)}&q=G-1005`,
            ),
          )
        ).items;
      const noMembership = async () => {
        expect(await inventory<Membership>('memberships')).toEqual([]);
        expect(await inventory<Follow>('follows')).toEqual([]);
      };
      const joinedDefaults = async (membershipId: string, generation: string) => {
        expect(await inventory<Membership>('memberships')).toMatchObject([
          {
            membershipId,
            generation,
            realm,
            space,
            member: memberAgent,
            following: true,
            source: 'join',
            level: 'highlights',
          },
        ]);
        expect(await inventory<Follow>('follows')).toMatchObject([
          { id: space, source: 'join', level: 'highlights' },
        ]);
      };
      const command = (policy: Policy) => ({
        actingSubject: memberAgent,
        expectedMembershipGeneration: policy.membershipGeneration,
        expectedPolicyRevision: policy.policyRevision,
        termsRevision: policy.termsRevision,
        listed: false,
      });
      const leave = async (generation: string) => {
        const policy = await joining(),
          key = randomUUID();
        const body = {
          profile: 'access-membership-change-v1',
          kind: 'realm',
          ownerSubject: realm,
          memberSubject: memberAgent,
          action: 'leave',
          expectedGeneration: generation,
          expectedPolicyRevision: policy.policyRevision,
        };
        const left = await json<{ generation: string; state: string }>(
          await call(newcomer, 'POST', '/v1/access/membership-changes', body, key),
        );
        expect(left).toMatchObject({
          state: 'left',
          generation: (BigInt(generation) + 1n).toString(),
        });
        expect(
          await json(await call(newcomer, 'POST', '/v1/access/membership-changes', body, key)),
        ).toMatchObject({ ...left, replayed: true });
        await noMembership();
      };
      await setAdmission('open');
      const policy = await joining();
      expect(policy).toMatchObject({
        open: true,
        selfJoin: true,
        state: 'absent',
        membershipGeneration: '0',
      });
      const input = command(policy),
        key = randomUUID();
      expect(
        (await call(newcomer, 'POST', `${root}/join`, { ...input, actingSubject: ownerAgent }))
          .status,
      ).toBe(403);
      expect(
        (await call(newcomer, 'POST', `${root}/join`, { ...input, expectedPolicyRevision: '0' }))
          .status,
      ).toBe(409);
      await noMembership();
      // The only member write is Join: its transaction supplies membership,
      // canonical Space follow and Highlights; no consent/Follow command precedes it.
      const [joined, concurrent] = await Promise.all([
        call(newcomer, 'POST', `${root}/join`, input, key),
        call(newcomer, 'POST', `${root}/join`, input, key),
      ]);
      const results = await Promise.all([json<Joined>(joined), json<Joined>(concurrent)]);
      const receipt = results[0]!;
      expect(receipt.membershipGeneration).toBe('1');
      expect(results[1]).toMatchObject({
        membershipId: receipt.membershipId,
        membershipGeneration: '1',
      });
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(await json(await call(newcomer, 'POST', `${root}/join`, input, key))).toMatchObject({
        ...receipt,
        replayed: true,
      });
      expect(
        (await call(newcomer, 'POST', `${root}/join`, { ...input, listed: true }, key)).status,
      ).toBe(409);
      expect((await call(newcomer, 'POST', `${root}/join`, input)).status).toBe(409);
      await joinedDefaults(receipt.membershipId, '1');
      await leave('1');
      const rejoin = await joining();
      expect(rejoin).toMatchObject({ state: 'left', membershipGeneration: '2', selfJoin: true });
      expect(
        await json(await call(newcomer, 'POST', `${root}/join`, command(rejoin))),
      ).toMatchObject({
        membershipId: receipt.membershipId,
        membershipGeneration: '3',
      });
      await joinedDefaults(receipt.membershipId, '3');
      await leave('3');

      await setAdmission('request');
      const requesting = await joining();
      expect(requesting).toMatchObject({ open: true, selfJoin: false, state: 'left' });
      expect((await call(newcomer, 'POST', `${root}/join`, command(requesting))).status).toBe(403);
      const basis = await json<Policy>(
        await call(
          newcomer,
          'GET',
          `${root}/join-requests/basis?actingSubject=${encodeURIComponent(memberAgent)}`,
        ),
      );
      const request = await json<{ requestId: string }>(
        await call(newcomer, 'POST', `${root}/join-requests`, {
          ...command(basis),
          listed: undefined,
          reason: 'Please admit me to participate',
        }),
        201,
      );
      await noMembership();
      const decision = {
        actingSubject: ownerAgent,
        expectedGeneration: (await settings()).generation,
        expectedRequestGeneration: '0',
        decision: 'accepted',
        reason: 'Approve the membership request',
      };
      expect(
        (
          await call(newcomer, 'POST', `${root}/join-requests/${request.requestId}/decisions`, {
            ...decision,
            actingSubject: memberAgent,
          })
        ).status,
      ).toBe(403);
      expect(
        await json(
          await call(
            owner,
            'POST',
            `${root}/join-requests/${request.requestId}/decisions`,
            decision,
          ),
          201,
        ),
      ).toMatchObject({
        membershipId: receipt.membershipId,
        membershipGeneration: '5',
      });
      await joinedDefaults(receipt.membershipId, '5');
      await leave('5');

      await setAdmission('invitation', 'private');
      expect(
        (
          await call(
            newcomer,
            'GET',
            `${root}/joining?actingSubject=${encodeURIComponent(memberAgent)}`,
          )
        ).status,
      ).toBe(403);
      expect((await call(newcomer, 'POST', `${root}/join`, command(requesting))).status).toBe(403);
      expect(
        (
          await call(
            newcomer,
            'GET',
            `${root}/join-requests/basis?actingSubject=${encodeURIComponent(memberAgent)}`,
          )
        ).status,
      ).toBe(404);
      await noMembership();
      const invitation = await json<{ invitation: { id: string; state: string } }>(
        await call(owner, 'POST', `${root}/invitations`, {
          actingSubject: ownerAgent,
          member: memberAgent,
          expiresInSeconds: 300,
        }),
      );
      expect(invitation.invitation.state).toBe('pending');
      expect(await joining()).toMatchObject({
        selfJoin: false,
        state: 'left',
        membershipGeneration: '6',
      });
      const accept = { actingSubject: memberAgent, action: 'accept', listed: false },
        acceptKey = randomUUID();
      expect(
        (
          await call(
            owner,
            'POST',
            `${root}/invitations/${invitation.invitation.id}/response`,
            accept,
          )
        ).status,
      ).toBe(403);
      const accepted = await json(
        await call(
          newcomer,
          'POST',
          `${root}/invitations/${invitation.invitation.id}/response`,
          accept,
          acceptKey,
        ),
      );
      expect(accepted).toMatchObject({
        invitation: { id: invitation.invitation.id, state: 'accepted' },
        replayed: false,
      });
      expect(
        await json(
          await call(
            newcomer,
            'POST',
            `${root}/invitations/${invitation.invitation.id}/response`,
            accept,
            acceptKey,
          ),
        ),
      ).toMatchObject({ ...(accepted as object), replayed: true });
      await joinedDefaults(receipt.membershipId, '7');
    } finally {
      await s.stop();
      if (authDirectory) rmSync(authDirectory, { recursive: true });
    }
  }, 180_000);
