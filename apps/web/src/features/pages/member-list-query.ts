import type { KernelClient } from '@rezics/client';
import {
  planReads,
  platformRegistry,
  PROFILE_ROUTE_PATTERN,
  isView,
  type CompositionDocument,
  type View,
} from '@rezics/composition';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../session/client';
import { requestLanguages } from '../../kernel/languages';
import { isRecord } from './shared';
import { validatePageNode, validateViewCursor } from './view-cursor';
import type { Section } from './overview';

export type MemberPageTarget = ({ subject: string; realm?: string } | { account: string } | { route: string }) & {
  view?: View;
};
export type MemberListRequest = { target: MemberPageTarget; locale: string; node: string; cursor?: string };

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
    authorization ? { headers: { authorization } } : undefined,
  );
  if (response.status !== 200 || !response.data) return { ok: false, status: response.status };
  const page = response.data;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject ?? null,
    ...(page.context ? { context: page.context } : {}),
    ...(input.cursor ? { continuation: { node: input.node, cursor: input.cursor } } : {}),
  });
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
    if (!isRecord(value) || typeof value.locale !== 'string' || !value.locale || value.locale.length > 35)
      throw new Error('Invalid list request');
    const node = validatePageNode(value.node);
    const cursor = value.cursor === undefined ? undefined : validateViewCursor(value.cursor);
    if (!node || (value.cursor !== undefined && !cursor)) throw new Error('Invalid continuation');
    return { target: targetOf(value.target), locale: value.locale, node, ...(cursor ? { cursor } : {}) };
  })
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const { prepareSession, viewerCredential } = await import('../../session/request');
    const { kernelClient } = await import('../../kernel/client');
    setResponseHeader('cache-control', 'private, no-store');
    await prepareSession(getRequest(), env as Partial<SessionEnv>);
    return readMemberList(kernelClient(data.locale), data, viewerCredential(getRequest()) ?? undefined);
  });
