import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { CreateType, TypeDescriptorRead, TypeDirectoryPage, TypeDirectoryQuery } from './create-subject';

type TypeDirectorySummary = {
  typeId: string;
  label: string;
  language: string | null;
  description: string | null;
  descriptionLanguage: string | null;
};
/** The native descriptor contains effective released hints; ancestors need no separate reads. */
export type TypeDirectoryDescriptor = TypeDirectorySummary & { definition: Record<string, unknown> };
type DescriptorRead =
  | { ok: true; descriptor: TypeDirectoryDescriptor }
  | { ok: false; reason: 'missing' | 'unavailable' };
type ApiResult<T> = { data?: T; error?: unknown };
type DefinitionTypesApi = {
  get(input: {
    query: { locale: string; query?: string; typeId?: string; cursor?: string; limit: number };
  }): Promise<ApiResult<{ types: TypeDirectorySummary[]; next: string | null }>>;
  (input: { typeId: string }): {
    get(input: { query: { locale: string } }): Promise<ApiResult<TypeDirectoryDescriptor>>;
  };
};

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = error.status;
  return typeof status === 'number' ? status : undefined;
}

/** KernelClient's generated surface has not added the delivered Type-directory route yet. */
function definitionTypes(locale: string) {
  return (kernelClient(locale) as unknown as { definitionTypes: DefinitionTypesApi }).definitionTypes;
}

function createType(summary: {
  typeId: string;
  label: string;
  language: string | null;
  description: string | null;
  descriptionLanguage: string | null;
}): CreateType {
  return {
    id: summary.typeId,
    label: summary.label,
    ...(summary.language ? { labelLanguage: summary.language } : {}),
    description: summary.description ?? '',
    ...(summary.descriptionLanguage ? { descriptionLanguage: summary.descriptionLanguage } : {}),
  };
}

/** A fresh caller-aware read every time: no descriptor survives authority or catalogue changes. */
export async function readTypeDescriptor(typeId: string, locale: string): Promise<DescriptorRead> {
  if (typeof typeId !== 'string' || typeId.length === 0 || typeId.length > 4_194_304)
    return { ok: false, reason: 'missing' };
  try {
    const response = await definitionTypes(locale)({ typeId }).get({ query: { locale } });
    if (response.error) return { ok: false, reason: httpStatus(response.error) === 404 ? 'missing' : 'unavailable' };
    const descriptor = response.data;
    if (
      !descriptor ||
      descriptor.typeId !== typeId ||
      typeof descriptor.label !== 'string' ||
      (descriptor.language !== null && typeof descriptor.language !== 'string') ||
      !descriptor.definition ||
      typeof descriptor.definition !== 'object' ||
      Array.isArray(descriptor.definition)
    )
      return { ok: false, reason: 'unavailable' };
    return { ok: true, descriptor };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** U exact reads for U distinct Types in the caller's finite page, with at most four in flight. */
export async function readTypeDescriptors(
  types: Iterable<string>,
  locale: string,
): Promise<Map<string, TypeDirectoryDescriptor>> {
  const wanted = [...new Set(types)];
  const descriptors = new Map<string, TypeDirectoryDescriptor>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, wanted.length) }, async () => {
      while (next < wanted.length) {
        const type = wanted[next++]!;
        const result = await readTypeDescriptor(type, locale);
        if (result.ok) descriptors.set(type, result.descriptor);
      }
    }),
  );
  return descriptors;
}

export const readCreateTypePage = createServerFn({ method: 'GET' })
  .validator((input: TypeDirectoryQuery): TypeDirectoryQuery => {
    const prefix = typeof input?.query === 'string';
    const exact = typeof input?.typeId === 'string';
    if (
      prefix === exact ||
      (prefix && input.query!.length > 512) ||
      (exact && (input.typeId!.length === 0 || input.typeId!.length > 4_194_304)) ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096)) ||
      (exact && input.cursor !== undefined)
    )
      throw new Error('Invalid Type directory request');
    return input;
  })
  .handler(async ({ data }): Promise<TypeDirectoryPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale() ?? 'en';
    try {
      const response = await definitionTypes(locale).get({
        query: {
          locale,
          ...(data.query === undefined ? {} : { query: data.query }),
          ...(data.typeId === undefined ? {} : { typeId: data.typeId }),
          ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
          limit: 20,
        },
      });
      if (response.error) return { ok: false, reason: httpStatus(response.error) === 409 ? 'stale' : 'unavailable' };
      if (!response.data) return { ok: false, reason: 'unavailable' };
      return { ok: true, types: response.data.types.map(createType), next: response.data.next };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });

export const readCreateTypeDescriptor = createServerFn({ method: 'GET' })
  .validator((typeId: string) => {
    if (typeof typeId !== 'string' || typeId.length === 0 || typeId.length > 4_194_304)
      throw new Error('Invalid Type ID');
    return typeId;
  })
  .handler(async ({ data }): Promise<TypeDescriptorRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale() ?? 'en';
    const result = await readTypeDescriptor(data, locale);
    return result.ok ? { ok: true, type: createType(result.descriptor) } : result;
  });
