import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ContentCore, SaveDraftCommand } from '../../content/src/core.ts';
import { ContentConflict } from '../../content/src/core.ts';
import { AdmissionDenied, AdmissionExpired } from '../src/modules/access/admission.ts';
import {
  canReadContentTarget, CONTENT_TARGET_COST, contentTargetGuard, ContentDraftDenied,
  ContentDraftUnavailable, resolveContentTarget, saveAdmittedContentDraft,
  type AuthoredContentDraftInput, type ContentReadAuthority,
} from '../src/modules/content-publication/draft.ts';
import { admittedTypes, compiledType, installRegisteredTypes, workSemanticTypeOptions,
  creatableWorkTypeOptions } from '../src/modules/types/registry.ts';
import { nativePostType, workContentTypes } from '../src/modules/work/work-kinds.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const resource = () => `https://rezics.com/id/${randomUUID()}`;
const zoneType = 'https://rezics.com/vocab/Zone';
const organizationType = 'https://schema.org/Organization';
const workType = 'https://schema.org/CreativeWork';
const bookType = 'https://schema.org/Book';
const placeType = 'https://schema.org/Place';
const principal = { issuer: 'https://account.test', subject: 'writer', emailVerified: true };

afterEach(() => installRegisteredTypes([]));

function environment(types: string[]) {
  const queries: Array<{ query: string; bytes?: number }> = [];
  const state = { current: true };
  const env = {
    lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    fuseki: { query: async (query: string, bytes?: number) => {
      queries.push({ query, bytes });
      if (query.includes('SELECT DISTINCT ?type')) return {
        results: { bindings: types.map(type => ({ type: { value: type } })) },
      };
      return { boolean: state.current };
    } },
  } as unknown as WorkActivationEnvironment;
  return { env, queries, state };
}

test('native Post Content custody does not add a descriptive or creatable Work type', async () => {
  const h = environment([nativePostType]);
  const id = resource();
  expect(await resolveContentTarget(h.env, id)).toEqual({ type: nativePostType, zone: null });
  expect(workContentTypes()).toContain(nativePostType);
  for (const types of [admittedTypes.map(entry => entry.type), workSemanticTypeOptions, creatableWorkTypeOptions]) {
    expect(types).not.toContain(nativePostType);
  }
  expect(h.queries).toHaveLength(CONTENT_TARGET_COST.graphReads);
  expect(h.queries[0]!.bytes).toBe(CONTENT_TARGET_COST.graphBytes);
  expect(h.queries[0]!.query).toContain(`LIMIT ${CONTENT_TARGET_COST.types + 1}`);
  expect(h.queries[0]!.query).toContain(`<${nativePostType}>`);
  expect(h.queries[0]!.query).toContain(h.env.lineage.dataEpoch);
  expect(h.queries[0]!.query).toContain(h.env.lineage.routingEpoch);
  expect(h.queries[0]!.query).toContain('rv:restoreHold true');
});

test('target selection preserves native, Work, Organization, Zone and ordinary resource owners', async () => {
  const id = resource();
  for (const [types, type] of [
    [[bookType, workType], workType], [[bookType], bookType], [[placeType, bookType], bookType],
    [[nativePostType, workType], nativePostType], [[organizationType], organizationType],
    [[zoneType, placeType], zoneType], [[placeType], placeType],
  ] as const) {
    expect(await resolveContentTarget(environment([...types]).env, id))
      .toEqual({ type, zone: type === zoneType ? id : null });
  }
});

test('unknown, absent, ambiguous and overflowing identities fail closed within one type read', async () => {
  for (const types of [[], ['https://example.org/Unknown'], ['urn:bad:type>'],
    [zoneType, nativePostType], [zoneType, workType], [zoneType, bookType],
    [zoneType, organizationType], Array.from({ length: 65 }, () => nativePostType)]) {
    const h = environment(types);
    await expect(resolveContentTarget(h.env, resource())).rejects.toBeInstanceOf(ContentDraftUnavailable);
    expect(h.queries).toHaveLength(1);
  }
  const types = Array.from({ length: CONTENT_TARGET_COST.types }, () => nativePostType);
  expect(await resolveContentTarget(environment(types).env, resource())).toMatchObject({ type: nativePostType });
});

test('runtime Work metadata selects custody and refreshes head and ambiguity guards together', async () => {
  const type = 'https://example.org/AdmittedWork';
  installRegisteredTypes([{ definition: { ...compiledType(bookType)!, type, default: false },
    revision: '1', lifecycle: 'active' }]);
  expect(workContentTypes()).toContain(type);
  const id = resource();
  const target = await resolveContentTarget(environment([type]).env, id);
  const calls: string[] = [];
  const access: ContentReadAuthority = {
    canReadWork: async () => { calls.push('work'); return false; },
    withOwnerAuthority: async (_authority, operation) => { calls.push('ordinary'); return operation({} as never); },
  };
  expect(await canReadContentTarget(environment([type]).env, access, principal, resource(), id, target)).toBe(false);
  expect(calls).toEqual(['work']);
  expect(contentTargetGuard(id, { type: zoneType, zone: id })).toContain(`<${type}>`);
  expect(contentTargetGuard(id, target)).toContain(`<${type}>`);
  await expect(resolveContentTarget(environment([zoneType, type]).env, id))
    .rejects.toThrow('owner is ambiguous');
  installRegisteredTypes([]);
  expect(workContentTypes()).not.toContain(type);
  expect(() => contentTargetGuard(id, target)).toThrow(ContentDraftUnavailable);
});

test('dispatch guards retain heads, active complete Zones and resolved owner identity', () => {
  const id = resource();
  for (const type of [nativePostType, workType, bookType, zoneType, placeType, organizationType]) {
    const guard = contentTargetGuard(id, { type, zone: type === zoneType ? id : null });
    expect(guard).toContain(`<${id}> a <${type}>`);
    for (const ownerType of workContentTypes()) expect(guard).toContain(`<${ownerType}>`);
    for (const predicate of ['head', 'zoneState', 'space', 'zoneHead']) {
      expect(guard).toContain(`<https://rezics.com/vocab/${predicate}>`);
    }
    expect(guard).toContain('<https://rezics.com/vocab/Active>');
    if (type !== zoneType) expect(guard).toContain(`FILTER NOT EXISTS {\n      <${id}> a <${zoneType}>`);
    else expect(guard).toContain(`<${organizationType}>`);
    if ([placeType, organizationType].includes(type)) expect(guard).toContain('?otherWorkOwner');
  }
  expect(contentTargetGuard(id)).toContain(`<${nativePostType}>`);
  expect(() => contentTargetGuard(id, { type: nativePostType, zone: id })).toThrow(ContentDraftUnavailable);
  expect(() => contentTargetGuard(id, { type: zoneType, zone: resource() })).toThrow(ContentDraftUnavailable);
});

test('private native Post reads preserve canReadWork denial without ordinary policy fallback', async () => {
  const h = environment([nativePostType]);
  const id = resource(), actor = resource();
  const target = await resolveContentTarget(h.env, id);
  for (const allowed of [false, true]) {
    let ordinary = 0;
    const access: ContentReadAuthority = {
      canReadWork: async (actualPrincipal, actualActor, actualId) => {
        expect([actualPrincipal, actualActor, actualId]).toEqual([principal, actor, id]);
        return allowed;
      },
      withOwnerAuthority: async (_authority, operation) => { ordinary++; return operation({} as never); },
    };
    expect(await canReadContentTarget(h.env, access, principal, actor, id, target)).toBe(allowed);
    expect(ordinary).toBe(0);
  }
});

test('ordinary resource and Organization reads still require live owner authority', async () => {
  for (const type of [placeType, organizationType]) {
    const h = environment([type]);
    const id = resource(), actor = resource();
    const target = await resolveContentTarget(h.env, id);
    for (const error of [undefined, new AdmissionDenied('denied'), new AdmissionExpired('expired')]) {
      const access: ContentReadAuthority = {
        canReadWork: async () => { throw new Error('wrong owner'); },
        withOwnerAuthority: async (authority, operation) => {
          expect(authority).toEqual({ principal, actingSubject: actor, action: 'content.draft', scope: `content:draft:${id}` });
          if (error) throw error;
          return operation({} as never);
        },
      };
      expect(await canReadContentTarget(h.env, access, principal, actor, id, target)).toBe(!error);
    }
  }
});

test('native Post draft checks current identity before admission and again after claiming custody', async () => {
  for (const phase of ['live', 'before-admission', 'after-claim', 'denied'] as const) {
    const h = environment([nativePostType]);
    const id = resource();
    const input: AuthoredContentDraftInput = { resourceId: id,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: id,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, body: 'Chapter', notes: { after: { body: 'Author note' } },
      actingSubject: resource(), idempotencyKey: randomUUID() };
    const commands: SaveDraftCommand[] = [];
    let registrations = 0;
    const access = {
      register: async () => { registrations++; return { id: randomUUID(), state: 'registered', replayed: false }; },
      claim: async () => {
        if (phase === 'after-claim') h.state.current = false;
        if (phase === 'denied') throw new AdmissionDenied('revoked');
      },
      recordGraphOutcome: async () => {},
    } as unknown as Parameters<typeof saveAdmittedContentDraft>[3];
    const content = { saveDraft: async (command: SaveDraftCommand) => {
      commands.push(command);
      return { outcome: 'succeeded', revisionId: randomUUID(), predecessor: null,
        position: { owner: 'content', dataEpoch: randomUUID(), sequence: '1' }, replayed: false };
    }, readDraftReceipt: async () => null } as unknown as ContentCore;
    const account = { verify: async (_request: Request, scopes: readonly string[]) => {
      expect(scopes).toEqual(['work:edit']);
      return principal;
    } };
    if (phase === 'before-admission') h.state.current = false;
    const saved = saveAdmittedContentDraft(h.env, content, account, access,
      new Request('http://main.test/v1/content-drafts'), input);
    if (phase === 'live') {
      expect(await saved).toMatchObject({ outcome: 'succeeded' });
      expect(commands[0]!.model).toBe('content-shape-v2');
      expect(JSON.parse(commands[0]!.serializedJson).notes).toEqual(input.notes);
      expect(commands[0]!.provenance).toMatchObject({ author: input.actingSubject, rightsBasis: 'original-contribution' });
    } else {
      await expect(saved).rejects.toBeInstanceOf(phase === 'denied' ? ContentDraftDenied : ContentConflict);
      expect(commands).toHaveLength(0);
    }
    expect(registrations).toBe(phase === 'before-admission' ? 0 : 1);
    for (const { query } of h.queries.filter(({ query }) => query.includes('ASK'))) {
      expect(query).toContain('rv:restoreHold true');
      expect(query).toContain(h.env.lineage.dataEpoch);
      expect(query).toContain(h.env.lineage.routingEpoch);
      expect(query).toContain(`<${id}> a <${nativePostType}>`);
      expect(query).toContain('<https://rezics.com/vocab/head>');
    }
  }
});
