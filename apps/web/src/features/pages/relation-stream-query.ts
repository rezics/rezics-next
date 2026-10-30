import type { KernelClient } from '@rezics/client';
import {
  PAGE_GLOBAL_CONTEXT,
  isView,
  planReads,
  platformRegistry,
  type CompositionDocument,
  type View,
} from '@rezics/composition';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { notFound } from '@tanstack/react-router';
import { pageContext, loadSubjectPage, PageReadError } from './subject';
import { validatePageNode, validatePageRealm, validateViewCursor } from './view-cursor';
import type { Section } from './overview';
import { isRecord } from './shared';

export type RelationGroupRequest = {
  subject: string;
  locale: string;
  view: View;
  node: string;
  cursor: string;
  realm?: string | undefined;
  reader?: string | null;
  /** Expected current representation, never a Context override or a grant. */
  context?: string;
  population?: 'global' | 'realm';
};
export const relationGroupKey = (input: RelationGroupRequest) =>
  [
    'subject-relation-group',
    input.subject,
    input.locale,
    input.view,
    input.realm ?? null,
    input.node,
    input.cursor,
    input.reader ?? null,
    input.context ?? null,
    input.population ?? null,
  ] as const;

/** The native page resolver selects the current template, Context and one continued stream. */
export async function readRelationGroup(
  client: KernelClient,
  input: RelationGroupRequest,
  authorization?: string,
): Promise<Section> {
  let loaded;
  try {
    loaded = await loadSubjectPage(client, input.subject, input.view, input.locale, {
      realm: input.realm,
      authorization,
      continuation: { node: input.node, cursor: input.cursor },
    });
  } catch (error) {
    if (error instanceof PageReadError) return { ok: false, status: error.status };
    throw error;
  }
  if (loaded.kind !== 'page') return { ok: false, status: loaded.kind === 'missing' ? 404 : 409 };
  if (
    (input.context !== undefined && input.context !== (loaded.page.context?.id ?? PAGE_GLOBAL_CONTEXT)) ||
    (input.population !== undefined && input.population !== (loaded.page.context?.population.kind ?? 'global'))
  )
    return { ok: false, status: 409 };
  const plan = planReads(platformRegistry, loaded.page.document as CompositionDocument, pageContext(loaded.page));
  const key = plan.nodes[input.node];
  const read = key ? plan.reads[key] : undefined;
  const result = key ? loaded.page.reads[key] : undefined;
  if (!read || (read.kind !== 'links' && read.kind !== 'relations')) return { ok: false, status: 400 };
  return result?.status === 200 && isRecord(result.body)
    ? { ok: true, read, body: result.body }
    : { ok: false, status: result?.status };
}

export const loadRelationGroup = createServerFn({ method: 'GET', strict: false })
  .validator((value: unknown): RelationGroupRequest => {
    if (
      !isRecord(value) ||
      typeof value.subject !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(value.subject) ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35 ||
      !isView(value.view)
    )
      throw notFound();
    if (
      (value.reader !== undefined &&
        value.reader !== null &&
        (typeof value.reader !== 'string' || !value.reader || value.reader.length > 128)) ||
      (value.population !== undefined && value.population !== 'global' && value.population !== 'realm')
    )
      throw notFound();
    const node = validatePageNode(value.node);
    const cursor = validateViewCursor(value.cursor);
    if (!node || !cursor) throw notFound();
    return {
      subject: value.subject,
      locale: value.locale,
      view: value.view,
      node,
      cursor,
      realm: validatePageRealm(value.realm),
      ...(value.reader !== undefined ? { reader: value.reader as string | null } : {}),
      ...(value.context !== undefined ? { context: validatePageRealm(value.context)! } : {}),
      ...(value.population !== undefined ? { population: value.population } : {}),
    };
  })
  .handler(async ({ data }) => {
    const { subjectKernelClient } = await import('./subject-queries');
    setResponseHeader('cache-control', 'private, no-store');
    const { client, authorization } = await subjectKernelClient(data.locale, data.realm, data.reader);
    return readRelationGroup(client, data, authorization);
  });
