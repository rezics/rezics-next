import {
  bangumiGameEnvironment,
  bangumiGameEnvironmentForeignHost,
  bangumiGameEnvironmentReferenceKey,
  bangumiGameEnvironmentSourceHost,
  type BangumiGameEnvironmentProperty,
} from '../../../packages/conversion/src/bangumi-game-environment.ts';
import type { ImportIdentifierLookup, ImportIdentifierResolution } from './importer.ts';
import type { ReviewedSubjectRead } from './import-client.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BINDING_CAP = 24;
const READ_CAP = 24;

export type BangumiGameEnvironmentBinding = Readonly<{
  kind: 'platform' | 'engine';
  item: string;
  conceptId: string;
  sourceUri: string;
}>;

export type BangumiGameEnvironmentDiagnostic = Readonly<{
  sourceKey: string;
  pointer: string;
  code:
    | 'reviewed-binding-unavailable'
    | 'reviewed-binding-concealed'
    | 'reviewed-binding-wrong-source'
    | 'source-claim-unavailable';
}>;

function adoptedUrls(read: unknown): string[] {
  const statements = (read as { subject?: { statements?: Record<string, { value?: { content?: unknown } }[]> } })
    .subject?.statements?.['schema:url'];
  return (Array.isArray(statements) ? statements : []).flatMap((statement) =>
    typeof statement.value?.content === 'string' ? [statement.value.content] : [],
  );
}

function hostnameOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}

function propertyOf(kind: BangumiGameEnvironmentBinding['kind']): BangumiGameEnvironmentProperty {
  return kind === 'platform' ? 'schema:gamePlatform' : 'wdt:P408';
}

/** Current disclosed/adopted Concept reads; UUID and identical label are lookup hints only. */
export async function readBangumiGameEnvironmentBindings(
  bindings: readonly BangumiGameEnvironmentBinding[],
  read: (id: string) => Promise<ReviewedSubjectRead | null>,
  cache: Map<string, Promise<ReviewedSubjectRead | null>> = new Map(),
): Promise<{
  references: Record<string, string>;
  diagnostics: BangumiGameEnvironmentDiagnostic[];
  concealed: boolean;
}> {
  const references: Record<string, string> = {};
  const diagnostics: BangumiGameEnvironmentDiagnostic[] = [];
  const current = (id: string) => {
    let pending = cache.get(id);
    if (!pending) {
      pending =
        cache.size >= READ_CAP
          ? Promise.resolve(null)
          : Promise.resolve()
              .then(() => read(id))
              .catch(() => null);
      cache.set(id, pending);
    }
    return pending;
  };
  let concealed = false;
  const selected = bindings.slice(0, BINDING_CAP);
  for (const binding of selected) {
    const pointer = `/infobox/${binding.kind === 'platform' ? '平台' : '游戏引擎'}`;
    const host = hostnameOf(binding.sourceUri);
    if (
      typeof binding.item !== 'string' ||
      !binding.item.isWellFormed() ||
      !uuid.test(binding.conceptId) ||
      typeof binding.sourceUri !== 'string' ||
      !host ||
      !bangumiGameEnvironmentSourceHost(host)
    ) {
      diagnostics.push({ sourceKey: binding.item, pointer, code: 'reviewed-binding-wrong-source' });
      continue;
    }
    const page = await current(binding.conceptId);
    if (!page) {
      concealed = true;
      diagnostics.push({ sourceKey: binding.item, pointer, code: 'reviewed-binding-concealed' });
      continue;
    }
    const subject = (page as { subject?: { id?: string; type?: string } }).subject;
    if (!subject || subject.id !== binding.conceptId || subject.type !== 'skos:Concept') {
      concealed = true;
      diagnostics.push({ sourceKey: binding.item, pointer, code: 'reviewed-binding-concealed' });
      continue;
    }
    const urls = adoptedUrls(page);
    if (urls.some((url) => {
      const name = hostnameOf(url);
      return !!name && bangumiGameEnvironmentForeignHost(name);
    })) {
      diagnostics.push({ sourceKey: binding.item, pointer, code: 'reviewed-binding-wrong-source' });
      continue;
    }
    if (!urls.includes(binding.sourceUri)) {
      diagnostics.push({ sourceKey: binding.item, pointer, code: 'reviewed-binding-wrong-source' });
      continue;
    }
    try {
      references[bangumiGameEnvironmentReferenceKey(propertyOf(binding.kind), binding.item)] = binding.conceptId;
    } catch {
      diagnostics.push({ sourceKey: binding.item, pointer, code: 'source-claim-unavailable' });
    }
  }
  return { references, diagnostics, concealed };
}

export function mergeIdentifierResolutions(
  parts: readonly ImportIdentifierResolution[],
): ImportIdentifierResolution {
  const refs: Record<string, string> = {};
  const preserved = new Set<string>();
  let unavailable = 0;
  for (const part of parts) {
    if ('status' in part && part.status === 'unavailable') {
      unavailable++;
      for (const property of part.preserveProperties) preserved.add(property);
      continue;
    }
    Object.assign(refs, part);
  }
  if (unavailable === parts.length && parts.length)
    return { status: 'unavailable', preserveProperties: [...preserved] };
  return refs;
}

/** Ordinary importer lookup: current reviewed bindings only, no catalogue label scan. */
export function createShowcaseBangumiGameEnvironmentLookup(input: {
  sourceAlias: string;
  bindings: readonly BangumiGameEnvironmentBinding[];
  read: (id: string) => Promise<ReviewedSubjectRead | null>;
}): ImportIdentifierLookup & { diagnostics: () => BangumiGameEnvironmentDiagnostic[] } {
  const cache = new Map<string, Promise<ReviewedSubjectRead | null>>();
  const diagnostics = new Map<string, BangumiGameEnvironmentDiagnostic>();
  const lookup: ImportIdentifierLookup = {
    async resolve({ owner, conversion }) {
      if (owner.source !== input.sourceAlias || conversion.source !== 'bangumi') return {};
      const record = conversion.normalized as { type?: unknown; infobox?: unknown };
      if (record.type !== 4) return {};
      const projection = bangumiGameEnvironment({
        type: 4,
        ...(typeof record.infobox === 'string' ? { infobox: record.infobox } : {}),
      });
      if (!projection.items.length) return {};
      const needed = input.bindings.filter((binding) =>
        projection.items.some((item) => item.kind === binding.kind && item.item === binding.item),
      );
      const current = await readBangumiGameEnvironmentBindings(needed, input.read, cache);
      for (const item of projection.items) {
        const key = `${owner.external_id}\0${item.pointer}`;
        const matched = current.diagnostics.find(
          (row) => row.sourceKey === item.item && row.pointer.startsWith('/infobox/'),
        );
        if (matched) diagnostics.set(key, { ...matched, sourceKey: owner.external_id, pointer: item.pointer });
        else diagnostics.delete(key);
      }
      if (
        current.concealed &&
        !Object.keys(current.references).length &&
        needed.length > 0 &&
        current.diagnostics.every((row) => row.code === 'reviewed-binding-concealed')
      )
        return { status: 'unavailable', preserveProperties: ['schema:gamePlatform', 'wdt:P408'] };
      return current.references;
    },
  };
  return {
    ...lookup,
    diagnostics: () =>
      [...diagnostics.values()].sort(
        (left, right) => left.sourceKey.localeCompare(right.sourceKey) || left.pointer.localeCompare(right.pointer),
      ),
  };
}
