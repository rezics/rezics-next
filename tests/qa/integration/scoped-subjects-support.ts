import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { ProjectionStore } from '../../../services/main/src/modules/projection/store.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { SeedApiError } from '../../../scripts/dev/seed/api.ts';
import type { ScopedSubjectApi } from '../../../scripts/dev/seed/scoped-subjects-questions.ts';
import { startMediaStack } from './media-support.ts';

const sharedDefinitionKeys = new Set(['variant-of', 'holds-title', 'represents', 'in-continuity', 'appearance']);

/** Identity-link keys are project-wide. Read them from the shared object directory,
 * not from this fixture's work prefix, so a later file can open the same revision. */
export async function sharedDefinition(env: WorkActivationEnvironment, key: string) {
  const retained = env.workObjects;
  delete env.workObjects;
  try {
    const found = await readDefinitionByKey(env, key);
    return found ? { component: found.definition, revision: found.revision } : null;
  } finally { if (retained) env.workObjects = retained; }
}

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
  // A keyed definition sealed under the work prefix is invisible to later files
  // that read the shared object directory. Keep those bytes in that directory.
  const sharedComponents = new Set<string>();
  const sharesDefinitionBytes = (path: string, body?: object) => {
    if (!body) return false;
    if (path === '/v1/semantic/changes') {
      const state = (body as { state?: { component?: string; notation?: string } }).state;
      return state?.component === 'definition' && typeof state.notation === 'string'
        && sharedDefinitionKeys.has(state.notation);
    }
    if (path === '/v1/lexicon/presentations') {
      const definition = (body as { state?: { definition?: string } }).state?.definition;
      return typeof definition === 'string' && sharedComponents.has(definition);
    }
    return false;
  };
  const call = async (person: Person | null, method: string, path: string, body?: object, key: string = randomUUID()) => {
    const shared = method === 'POST' && sharesDefinitionBytes(path, body);
    const retained = stack.env.workObjects;
    if (shared) delete stack.env.workObjects;
    try {
      const response = await app.handle(new Request(`http://main.local${path}`, { method, headers: {
        ...(person ? { authorization: `Bearer ${person.token}` } : {}), 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      response.headers.set('x-scoped-request', `${method} ${path} (${key})`);
      if (shared && path === '/v1/semantic/changes' && response.ok) {
        const saved = await response.clone().json() as { component?: unknown };
        if (typeof saved.component === 'string') sharedComponents.add(saved.component);
      }
      return response;
    } finally { if (shared && retained) stack.env.workObjects = retained; }
  };
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
  return { stack, call, json, api, person, owner, authorize,
    findDefinition: (key: string) => sharedDefinition(stack.env, key), stop: () => stack.stop() };
}
