import type { KernelClient } from '@rezics/client';
import type { PropertyDefinition, TypeDefinition } from '@rezics/definitions';

type TypeDirectorySummary = {
  typeId: string;
  label: string;
  language: string | null;
  description: string | null;
  descriptionLanguage: string | null;
};
/** Effective released hints; display consumers do not need a property projection. */
export type TypeDirectoryDescriptor = TypeDirectorySummary & {
  definition: Record<string, unknown>;
  releaseDigest?: string;
  properties?: Record<string, PropertyDefinition>;
};
export type DescriptorRead =
  | { ok: true; descriptor: TypeDirectoryDescriptor }
  | { ok: false; reason: 'missing' | 'unavailable' };
export type CurrentTypeDescriptor = TypeDirectorySummary & {
  releaseDigest: string;
  definition: TypeDefinition;
  properties: Record<string, PropertyDefinition>;
};
export type CurrentTypeRead =
  | { ok: true; descriptor: CurrentTypeDescriptor }
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

export function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

/** One adapter for the delivered directory while KernelClient's generated surface catches up. */
export function definitionTypes(client: KernelClient): DefinitionTypesApi {
  return (client as unknown as { definitionTypes: DefinitionTypesApi }).definitionTypes;
}

/** Fresh caller-aware metadata: no descriptor outlives an authority or catalogue change. */
export async function readDirectoryDescriptor(
  client: KernelClient,
  typeId: string,
  locale: string,
): Promise<DescriptorRead> {
  if (typeof typeId !== 'string' || typeId.length === 0 || typeId.length > 4_194_304)
    return { ok: false, reason: 'missing' };
  try {
    const response = await definitionTypes(client)({ typeId }).get({ query: { locale } });
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

/** Admission consumers additionally require the complete bounded effective property projection. */
export async function readTypeDescriptor(
  client: KernelClient,
  typeId: string,
  locale = 'en',
): Promise<CurrentTypeRead> {
  const result = await readDirectoryDescriptor(client, typeId, locale);
  if (!result.ok) return result;
  const { descriptor } = result;
  const ids = descriptor.definition.properties;
  if (
    typeof descriptor.releaseDigest !== 'string' ||
    !descriptor.releaseDigest ||
    !descriptor.properties ||
    typeof descriptor.properties !== 'object' ||
    Array.isArray(descriptor.properties) ||
    !Array.isArray(ids) ||
    ids.length > 64 ||
    ids.some((id) => typeof id !== 'string' || !Object.hasOwn(descriptor.properties!, id))
  )
    return { ok: false, reason: 'unavailable' };
  return { ok: true, descriptor: descriptor as CurrentTypeDescriptor };
}
