import type { KernelClient } from '@rezics/client';
import { parseFilter, type FilterDocument } from '@rezics/filter';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  asSession,
  fromKernel,
  kernelHeaders,
  refused,
  writeSession,
  type CollectionWriteResult,
} from './collection-records';
import { loadCollectionRule, loadCollectionRuleChoices } from './collection-rule-read';
import { validateRuleLabelPage } from './collection-rule-label-input';

export type RuleWrite = {
  id?: string;
  revision?: number;
  title?: string;
  description?: string;
  filter: FilterDocument;
  sort: 'id';
  idempotencyKey: string;
};
export function validateRuleWrite(input: unknown): RuleWrite {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid rule');
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !['id', 'revision', 'title', 'description', 'filter', 'sort', 'idempotencyKey'].includes(key),
    ) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.idempotencyKey) ||
    value.sort !== 'id'
  )
    throw new Error('Invalid rule');
  const filter = parseFilter(value.filter);
  if (value.id !== undefined) {
    if (
      value.title !== undefined ||
      value.description !== undefined ||
      typeof value.id !== 'string' ||
      !value.id ||
      value.id.length > 128 ||
      typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0
    )
      throw new Error('Invalid rule revision');
    return { id: value.id, revision: value.revision, filter, sort: 'id', idempotencyKey: value.idempotencyKey };
  }
  if (
    value.revision !== undefined ||
    typeof value.title !== 'string' ||
    !value.title ||
    value.title.length > 512 ||
    typeof value.description !== 'string' ||
    value.description.length > 20000
  )
    throw new Error('Invalid Collection metadata');
  return {
    title: value.title,
    description: value.description,
    filter,
    sort: 'id',
    idempotencyKey: value.idempotencyKey,
  };
}

/** One unchanged intent per retry. Native create and PUT retain all scope, gate and execution decisions. */
export async function submitCollectionRule(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  value: RuleWrite,
): Promise<CollectionWriteResult> {
  try {
    const input = validateRuleWrite(value);
    const session = await writeSession(request, sessionEnv);
    if (!asSession(session)) return session;
    const headers = kernelHeaders(session.authorization, input.idempotencyKey);
    const result = input.id
      ? await client
          .collections({ collectionId: input.id })
          .rule.put({ revision: input.revision!, filter: input.filter, sort: input.sort }, { headers })
      : await client.collections.post(
          {
            membershipKind: 'dynamic',
            title: input.title!,
            description: input.description!,
            visibility: 'private',
            rule: { filter: input.filter, sort: input.sort },
          },
          { headers },
        );
    const id = result.data?.collection.id ?? input.id ?? '';
    return fromKernel(result, id);
  } catch (error) {
    return refused(error);
  }
}

export const readCollectionRule = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (input !== undefined && (typeof input !== 'string' || !input || input.length > 128))
      throw new Error('Invalid Collection');
    return input as string | undefined;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadCollectionRule(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
export const saveCollectionRule = createServerFn({ method: 'POST' })
  .validator(validateRuleWrite)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return submitCollectionRule(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
export const readCollectionRuleChoices = createServerFn({ method: 'GET' })
  .validator(validateRuleLabelPage)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadCollectionRuleChoices(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
