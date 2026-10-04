import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { GLOBAL_TARGET_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/target-context-authority.ts';
import { ProjectionStore } from '../../../services/main/src/modules/projection/store.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { SEMANTIC_TERMS } from '../../../services/main/src/modules/semantic/schema.ts';
import { startMediaStack } from './media-support.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';

export const short = (value: string) => value.slice(-36);
export const RV = 'https://rezics.com/vocab/';
export const nativeId = () => `https://rezics.com/id/${randomUUID()}`;
export interface Question {
  context: string;
  contextRevision: string;
  targetGrain: string;
  displayThreshold: number;
}
export interface Opinion {
  observation: string;
  observationRevision: string;
  value: number | null;
}
export interface Projection {
  id: string;
  revision: string;
  subject: string;
  frames: string[];
}

export async function scopedJudgmentsFixture() {
  const stack = await startMediaStack('scoped-judgments');
  const health = await stack.fuseki.commandHealth();
  for (const id of [
    'realm-target-rating-context-v4',
    'realm-target-rating-observation-v4',
  ] as const) {
    if (health.profiles[id] !== profileRegistry[id].sha256)
      throw new Error(
        `Scoped profile mismatch ${id}: native=${health.profiles[id]} expected=${profileRegistry[id].sha256}`,
      );
  }
  type Person = Awaited<ReturnType<typeof stack.member>> & { verified: boolean };
  const people = new Map<string, Person>();
  const account = {
    verify: async (request: Request) => {
      const person = people.get(
        request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
      );
      if (!person) throw new AccountAssertionDenied();
      const principal = { ...person.principal, emailVerified: person.verified };
      return {
        ...principal,
        currentAssertion: async () => ({ ...person.principal, emailVerified: person.verified }),
      };
    },
  };
  const app = createMainApp(stack.fuseki, {
    environment: stack.env,
    access: stack.access,
    account,
    content: stack.content,
    contentAuthoring: stack.content,
    media: stack.media,
    mediaAccess: stack.mediaAccess,
    agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
    projections: new ProjectionStore(stack.accessPool),
    reviews: new ReaderReviews(stack.accessPool),
    realmReplies: new RealmReplyStore(
      new RealmReplyContentStore(stack.contentPool),
      stack.content,
      stack.access,
      stack.env,
    ),
    targetRatingInventory: new TargetRatingInventoryStore(stack.accessPool),
  });
  const call = (
    person: Person | null,
    method: string,
    path: string,
    body?: object,
    key = randomUUID(),
  ) =>
    app
      .handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            ...(person ? { authorization: `Bearer ${person.token}` } : {}),
            'idempotency-key': key,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      )
      .then((response) => {
        response.headers.set('x-scoped-request', `${method} ${path}`);
        return response;
      });
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text();
    if (response.status !== status)
      throw new Error(
        `${response.headers.get('x-scoped-request')}: expected ${status}, got ${response.status}: ${text}`,
      );
    return JSON.parse(text) as T;
  };
  const person = async (name: string) => {
    const made = { ...(await stack.member(name)), verified: true };
    people.set(made.token, made);
    const provisioned = await json<{ agent: string }>(
      await call(made, 'POST', '/v1/agents', {
        profile: 'agent-provision-v1',
        kind: 'person',
        displayName: name,
      }),
      201,
    );
    made.actor = provisioned.agent;
    return made;
  };
  const grant = async (member: Person, scope: string, action: string) => {
    // Controlled fixture grant: provisioning supplied the real live controller.
    await stack.accessPool.query(
      'INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING',
      [scope],
    );
    await stack.accessPool.query(
      `INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,now()+interval '1 hour')`,
      [randomUUID(), member.principalId, member.actor, action],
    );
    await stack.accessPool.query(
      `INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES ($1,$2,$2,$3,$4,now()+interval '1 hour')`,
      [randomUUID(), member.actor, scope, action],
    );
  };
  const owner = await person('question-owner'),
    outsider = await person('non-member-reader');
  // This fixture needs two exact command grants, independent of whichever
  // account another file designated as the project's first administrator.
  await grant(owner, 'semantic:create:root', 'semantic.change');
  await grant(owner, GLOBAL_TARGET_CONTEXT_SCOPE, 'rating.context.create');
  const work = await stack.publicWork(owner.actor);
  const realm = (
    await json<{ realm: string }>(
      await call(owner, 'POST', '/v1/spaces', {
        profile: 'space-realm-v1',
        name: 'Scoped questions',
        language: 'en',
        capabilities: ['realm'],
        actingSubject: owner.actor,
      }),
      201,
    )
  ).realm;
  await grant(owner, `rating:context:${realm}`, 'rating.context.create');
  const semantic = async (name: string, type = `${RV}Character`) =>
    (
      await json<{ component: string; revision: string }>(
        await call(owner, 'POST', '/v1/semantic/changes', {
          profile: 'semantic-change-v1',
          expectedHead: null,
          actingSubject: owner.actor,
          state: {
            component: 'resource',
            types: [type],
            properties: [
              {
                predicate: 'https://schema.org/name',
                value: { kind: 'language-string', lexical: name, language: 'en' },
              },
              {
                predicate: SEMANTIC_TERMS.semanticWork,
                value: { kind: 'resource', ref: work.work },
              },
            ],
          },
        }),
        201,
      )
    ).component;
  const question = async (extra: Record<string, unknown> = {}, creator = owner) =>
    json<Question>(
      await call(creator, 'POST', '/v1/rating-contexts', {
        profile: 'realm-target-rating-context-v4',
        realm,
        question: `How did this subject do? ${randomUUID().slice(0, 8)}`,
        language: 'en',
        targetGrain: 'projection',
        actingSubject: creator.actor,
        ...extra,
      }),
      201,
    );
  const project = async (subject: string, frames: string[]) =>
    (
      await json<{ projection: Projection }>(
        await call(owner, 'POST', '/v1/projections', {
          subject,
          frames,
          actingSubject: owner.actor,
        }),
        201,
      )
    ).projection;
  const ratingBody = (
    member: Person,
    context: string,
    target: string,
    value: number | null = 8,
    expectedRevisionHead: string | null = null,
  ) => ({
    profile: 'realm-target-rating-observation-v1',
    context,
    target,
    value,
    expectedRevisionHead,
    actingSubject: member.actor,
  });
  const reviewBody = (member: Person, context: string, target: string) => ({
    profile: 'reader-review-command-v1',
    context,
    target,
    actingSubject: member.actor,
    expectedRevision: null,
    language: 'en',
    text: 'An opinion about this subject in its frame.',
    spoiler: false,
  });
  const page = (
    target: string,
    selectedRealm: string | null = realm,
    limit = 20,
    cursor?: string,
  ) => {
    const search = new URLSearchParams({
      scope: selectedRealm ? 'realm' : 'global',
      limit: String(limit),
    });
    if (selectedRealm) search.set('realm', selectedRealm);
    if (cursor) search.set('cursor', cursor);
    return call(null, 'GET', `/v1/resources/${short(target)}/rating-contexts?${search}`);
  };
  return {
    stack,
    call,
    json,
    owner,
    outsider,
    person,
    grant,
    work,
    realm,
    semantic,
    question,
    project,
    ratingBody,
    reviewBody,
    page,
    stop: () => stack.stop(),
  };
}
