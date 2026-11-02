import type { KernelClient } from '@rezics/client';
import {
  PAGE_GLOBAL_CONTEXT,
  planReads,
  platformRegistry,
  PROFILE_ROUTE_PATTERN,
  PageContinuationError,
  PageReadLimitError,
  isView,
  type CompositionDocument,
  type SelectedContext,
  type View,
} from '@rezics/composition';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../session/client';
import { requestLanguages } from '../../kernel/languages';
import { isRecord } from './shared';
import { validatePageNode, validatePageRealm, validateViewCursor } from './view-cursor';
import type { PageRepresentation, Section } from './overview';

export type MemberPageTarget = ({ subject: string; realm?: string } | { account: string } | { route: string }) & {
  view?: View;
};
export type MemberListRequest = {
  target: MemberPageTarget;
  locale: string;
  node: string;
  cursor?: string;
  /** A mismatch check only; the BFF derives authorization from the prepared request credential. */
  expectedReader: string | null;
  representation: PageRepresentation;
};

/** Plan against the resolved page account and representation returned by this same native read. */
export function memberContinuationPlan(
  page: {
    subject?: string | null;
    account?: { id: string; handle: string } | null;
    context?: SelectedContext;
  },
  document: CompositionDocument,
  input: Pick<MemberListRequest, 'node' | 'cursor'>,
) {
  return planReads(platformRegistry, document, {
    subject: page.subject ?? null,
    account: page.account ?? null,
    ...(page.context ? { context: page.context } : {}),
    ...(input.cursor ? { continuation: { node: input.node, cursor: input.cursor } } : {}),
  });
}

type NativeMemberPage = {
  subject?: string;
  account?: string;
  template: { scope: string; key: string | null };
};

/** Template keys identify routes, never subjects, account handles or views. */
function matchesNativeTarget(page: NativeMemberPage, target: MemberPageTarget): boolean {
  if ('route' in target)
    return (
      page.subject === undefined &&
      page.account === undefined &&
      ((page.template.scope === 'route' && page.template.key === target.route) ||
        (page.template.scope === 'generic' && page.template.key === null))
    );
  if (page.template?.scope === 'route') return false;
  if ('subject' in target) return page.subject === target.subject && page.account === undefined;
  // The DTO resolves a handle to an ID, without echoing the handle. Its native target resolution is authoritative.
  return typeof page.account === 'string' && page.account.length > 0;
}

/** Reload the current native composition, retaining its exact source and predicate on every continuation. */
export async function readMemberList(
  client: KernelClient,
  input: MemberListRequest,
  authorization?: string,
): Promise<Section> {
  const response = await client.pages.$read.post(
    {
      target: input.target,
      languages: requestLanguages(input.locale),
      ...(input.cursor ? { continuation: { node: input.node, cursor: input.cursor } } : {}),
    },
    {
      fetch: { redirect: 'manual' },
      ...(authorization ? { headers: { authorization } } : {}),
    },
  );
  if (response.status !== 200 || !response.data) return { ok: false, status: response.status };
  const page = response.data;
  const contextId = page.context?.id ?? PAGE_GLOBAL_CONTEXT;
  const population = page.context?.population;
  const populationKind = population?.kind ?? 'global';
  const populationId = population?.kind === 'realm' ? population.id : undefined;
  if (
    input.representation.context !== contextId ||
    input.representation.population !== populationKind ||
    input.representation.populationId !== populationId
  )
    return { ok: false, status: 409 };
  // A merge or agent-address change belongs to ordinary canonical routing, not this list's retained window.
  if (!matchesNativeTarget(page, input.target)) return { ok: false, status: 409 };
  // The page API returns the resolved account ID; retain the validated account handle only for its planner shape.
  const resolvedAccount =
    typeof page.account === 'string' && 'account' in input.target
      ? { id: page.account, handle: input.target.account }
      : null;
  let plan: ReturnType<typeof memberContinuationPlan>;
  try {
    plan = memberContinuationPlan(
      {
        subject: page.subject ?? null,
        account: resolvedAccount,
        ...(page.context ? { context: page.context } : {}),
      },
      page.document as CompositionDocument,
      input,
    );
  } catch (error) {
    if (error instanceof PageContinuationError || error instanceof PageReadLimitError)
      return { ok: false, status: 409 };
    throw error;
  }
  if ('account' in input.target) {
    // When the document exposes native account identity, it must agree with both the resolved ID and address.
    // Documents without it cannot independently prove the ID/handle relationship; do not invent another lookup.
    for (const [key, descriptor] of Object.entries(plan.reads)) {
      if (descriptor.kind !== 'account') continue;
      const identity = page.reads[key];
      if (identity?.status !== 200) continue;
      const accounts = isRecord(identity.body) ? identity.body.accounts : undefined;
      const account = Array.isArray(accounts) ? accounts[0] : undefined;
      if (
        !isRecord(account) ||
        account.id !== page.account ||
        typeof account.handle !== 'string' ||
        account.handle.toLowerCase() !== input.target.account.toLowerCase() ||
        account.movedTo !== undefined
      )
        return { ok: false, status: 409 };
    }
  }
  const key = plan.nodes[input.node];
  const read = key ? plan.reads[key] : undefined;
  const result = key ? page.reads[key] : undefined;
  if (!read || (read.kind !== 'members' && read.kind !== 'search')) return { ok: false, status: 400 };
  return result?.status === 200 && isRecord(result.body)
    ? { ok: true, read, body: result.body }
    : { ok: false, status: result?.status };
}

function targetOf(value: unknown): MemberPageTarget {
  if (!isRecord(value)) throw new Error('Invalid page target');
  const keys = ['subject', 'account', 'route'].filter((key) => Object.hasOwn(value, key));
  if (
    keys.length !== 1 ||
    Object.keys(value).some((key) => !['subject', 'account', 'route', 'realm', 'view'].includes(key))
  )
    throw new Error('Invalid page target');
  if (value.view !== undefined && !isView(value.view)) throw new Error('Invalid page view');
  if (typeof value.subject === 'string' && /^[0-9a-f-]{36}$/.test(value.subject)) {
    if (value.realm !== undefined && (typeof value.realm !== 'string' || !/^[0-9a-f-]{36}$/.test(value.realm)))
      throw new Error('Invalid Realm');
  } else if (typeof value.account === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.account)) {
    if (value.realm !== undefined) throw new Error('Invalid Realm');
  } else if (
    typeof value.route === 'string' &&
    value.route.length <= 256 &&
    new RegExp(PROFILE_ROUTE_PATTERN).test(value.route)
  ) {
    if (value.realm !== undefined || value.view !== undefined) throw new Error('Invalid route target');
  } else throw new Error('Invalid page target');
  return value as MemberPageTarget;
}

export const loadMemberList = createServerFn({ method: 'GET', strict: false })
  .validator((value: unknown): MemberListRequest => {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => !['target', 'locale', 'node', 'cursor', 'expectedReader', 'representation'].includes(key),
      ) ||
      typeof value.locale !== 'string' ||
      !value.locale ||
      value.locale.length > 35 ||
      (value.expectedReader !== null &&
        (typeof value.expectedReader !== 'string' || !value.expectedReader || value.expectedReader.length > 128))
    )
      throw new Error('Invalid list request');
    const node = validatePageNode(value.node);
    const cursor = value.cursor === undefined ? undefined : validateViewCursor(value.cursor);
    if (!node || (value.cursor !== undefined && !cursor)) throw new Error('Invalid continuation');
    const representation = value.representation;
    const representationContext = isRecord(representation) ? validatePageRealm(representation.context) : undefined;
    const populationId =
      isRecord(representation) && representation.population === 'realm'
        ? validatePageRealm(representation.populationId)
        : undefined;
    if (
      !isRecord(representation) ||
      Object.keys(representation).some((key) => !['context', 'population', 'populationId'].includes(key)) ||
      !representationContext ||
      (representation.population !== 'global' && representation.population !== 'realm') ||
      (representation.population === 'global' && representation.populationId !== undefined) ||
      (representation.population === 'realm' && !populationId)
    )
      throw new Error('Invalid page representation');
    return {
      target: targetOf(value.target),
      locale: value.locale,
      node,
      ...(cursor ? { cursor } : {}),
      expectedReader: value.expectedReader as string | null,
      representation: {
        context: representationContext,
        population: representation.population as 'global' | 'realm',
        ...(populationId ? { populationId } : {}),
      },
    };
  })
  .handler(async ({ data }): Promise<Section> => {
    setResponseHeader('cache-control', 'private, no-store');
    let authorization: string | undefined;
    if (data.expectedReader !== null) {
      const { env } = await import('cloudflare:workers');
      const { prepareSession, sessionSubject, viewerCredential } = await import('../../session/request');
      const request = getRequest();
      await prepareSession(request, env as Partial<SessionEnv>);
      const credential = viewerCredential(request);
      const reader = credential
        ? (sessionSubject(request) ??
          `credential:${Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential))),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('')}`)
        : null;
      if (reader !== data.expectedReader) return { ok: false, status: 409 };
      authorization = credential ?? undefined;
    }
    const { kernelClient } = await import('../../kernel/client');
    return readMemberList(kernelClient(data.locale), data, authorization);
  });
