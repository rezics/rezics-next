import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { ProjectionStore } from '../../../services/main/src/modules/projection/store.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { SeedApiError } from '../../../scripts/dev/seed/api.ts';
import type { ScopedSubjectApi } from '../../../scripts/dev/seed/scoped-subjects-questions.ts';
import { startMediaStack } from './media-support.ts';

export async function scopedSubjectsFixture() {
  const stack = await startMediaStack('scoped-subjects');
  const workObjects = stack.objects('semantic/work/');
  const structureObjects = stack.objects('semantic/structure/');
  await workObjects.initialize(); await structureObjects.initialize();
  Object.assign(stack.env, { workObjects, structureObjects });
  type Person = Awaited<ReturnType<typeof stack.member>>;
  const people = new Map<string, Person>();
  const account = { verify: async (request: Request) => {
    const person = people.get(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    if (!person) throw new Error('Unknown fixture principal');
    const principal = { ...person.principal, emailVerified: true };
    return { ...principal, currentAssertion: async () => principal };
  } };
  const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, account,
    content: stack.content, contentAuthoring: stack.content, media: stack.media, mediaAccess: stack.mediaAccess,
    structureObjects, catalogueIntake: new CatalogueIntakeStore(stack.accessPool, stack.env),
    agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
    projections: new ProjectionStore(stack.accessPool), targetRatingInventory: new TargetRatingInventoryStore(stack.accessPool),
  });
  const call = (person: Person | null, method: string, path: string, body?: object, key: string = randomUUID()) =>
    app.handle(new Request(`http://main.local${path}`, { method, headers: {
      ...(person ? { authorization: `Bearer ${person.token}` } : {}), 'idempotency-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) })).then(response => {
      response.headers.set('x-scoped-request', `${method} ${path} (${key})`);
      return response;
    });
  const json = async <T>(response: Response): Promise<T> => {
    const text = await response.text();
    if (!response.ok || response.status === 202) throw new SeedApiError(response.headers.get('x-scoped-request')!, response.status, text);
    return JSON.parse(text) as T;
  };
  const api = (person: Person | null): ScopedSubjectApi => ({
    get: <T>(path: string) => call(person, 'GET', path).then(response => json<T>(response)),
    post: <T>(path: string, body: object, key: string) => call(person, 'POST', path, body, key).then(response => json<T>(response)),
    put: <T>(path: string, body: object, key: string) => call(person, 'PUT', path, body, key).then(response => json<T>(response)),
  });
  const person = async (name: string) => {
    const made = await stack.member(name);
    people.set(made.token, made);
    const agent = await api(made).post<{ agent: string }>('/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: name,
    }, randomUUID());
    made.actor = agent.agent;
    return made;
  };
  const owner = await person('scoped-curator');
  const authorities = new Set<string>();
  const authorize = async (scope: string, action: string, actor = owner.actor) => {
    const tuple = `${actor}\0${scope}\0${action}`;
    if (authorities.has(tuple)) return;
    await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,$4,now()+interval '1 hour')`,
    [randomUUID(), owner.principalId, actor, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until) VALUES ($1,$2,$2,$3,$4,now()+interval '1 hour')`,
    [randomUUID(), actor, scope, action]);
    authorities.add(tuple);
  };
  return { stack, call, json, api, person, owner, authorize, stop: () => stack.stop() };
}
