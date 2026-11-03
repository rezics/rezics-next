import type { Release } from '@rezics/definitions';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { CreateType, TypeDescriptorRead, TypeDirectoryPage, TypeDirectoryQuery } from './create-subject';
import {
  definitionTypes,
  httpStatus,
  readDirectoryDescriptor,
  readTypeDescriptor as readCurrentDescriptor,
  type TypeDirectoryDescriptor,
  type DescriptorRead,
  type CurrentTypeRead,
} from './type-directory-client';
export type { TypeDirectoryDescriptor } from './type-directory-client';

function createType(
  summary: {
    typeId: string;
    label: string;
    language: string | null;
    description: string | null;
    descriptionLanguage: string | null;
  },
  definition?: Record<string, unknown>,
): CreateType {
  const listed = definition?.bases;
  const bases = Array.isArray(listed)
    ? listed.filter((base): base is string => typeof base === 'string' && base.length > 0 && base.length <= 256)
    : [];
  return {
    id: summary.typeId,
    label: summary.label,
    ...(summary.language ? { labelLanguage: summary.language } : {}),
    description: summary.description ?? '',
    ...(summary.descriptionLanguage ? { descriptionLanguage: summary.descriptionLanguage } : {}),
    ...(bases.length ? { bases } : {}),
  };
}

/** A fresh caller-aware read every time: no descriptor survives authority or catalogue changes. */
export async function readTypeDescriptor(typeId: string, locale: string): Promise<DescriptorRead> {
  return readDirectoryDescriptor(kernelClient(locale), typeId, locale);
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

/** Relation editing requires the bounded effective properties of the exact current Type. */
export async function readRelationTypeDescriptor(typeId: string, locale: string): Promise<CurrentTypeRead> {
  const client = kernelClient(locale);
  const result = await readCurrentDescriptor(client, typeId, locale);
  if (!result.ok) return result;
  const { descriptor } = result;
  const missing = new Set<string>();
  for (const id of descriptor.definition.properties) {
    const property = descriptor.properties[id];
    if (!property?.relation || property.relation.group === 'classification' || !Array.isArray(property.qualifiers))
      continue;
    for (const qualifier of property.qualifiers) {
      if (!Object.hasOwn(descriptor.properties, qualifier)) missing.add(qualifier);
    }
  }
  if (!missing.size) return result;
  try {
    const release = await client.definitions.releases({ digest: descriptor.releaseDigest }).get();
    if (release.status !== 200 || release.data?.digest !== descriptor.releaseDigest || !release.data.release)
      return { ok: false, reason: 'unavailable' };
    const properties = (release.data.release as Release).properties;
    if (!properties) return { ok: false, reason: 'unavailable' };
    const completed = { ...descriptor.properties };
    for (const id of missing) {
      const definition = properties[id];
      if (!definition?.labels || !Object.keys(definition.labels).length) return { ok: false, reason: 'unavailable' };
      completed[id] = definition;
    }
    return { ok: true, descriptor: { ...descriptor, properties: completed } };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
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
      const response = await definitionTypes(kernelClient(locale)).get({
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
    return result.ok ? { ok: true, type: createType(result.descriptor, result.descriptor.definition) } : result;
  });

export const readCurrentTypeDescriptor = createServerFn({ method: 'GET' })
  .validator((typeId: string) => {
    if (typeof typeId !== 'string' || typeId.length === 0 || typeId.length > 4_194_304)
      throw new Error('Invalid Type ID');
    return typeId;
  })
  .handler(async ({ data }): Promise<CurrentTypeRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale() ?? 'en';
    return readCurrentDescriptor(kernelClient(locale), data, locale);
  });
