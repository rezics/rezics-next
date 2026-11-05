import { SearchUnavailableError, type OpenSearch } from './opensearch.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exact native physical identity, never the alias, numeric generation or cached coverage protocol. */
export async function readIdentityIndexIncarnation(search: OpenSearch, index: string): Promise<string> {
  if (/^[a-z0-9][a-z0-9-]{0,127}subjects-g[1-9][0-9]*$/.exec(index)?.[0] !== index)
    throw new TypeError('Identity writer requires a physical subject index');
  const response = await search.request('GET', `/${index}/_settings`);
  const unavailable = () => new SearchUnavailableError('Native subject index incarnation is unavailable');
  if (response.status !== 200 || !record(response.body) || Object.keys(response.body).length !== 1) throw unavailable();
  const target = response.body[index];
  if (!record(target) || !record(target.settings) || !record(target.settings.index)) throw unavailable();
  const uuid = target.settings.index.uuid;
  if (typeof uuid !== 'string' || /^[A-Za-z0-9_-]{1,128}$/.exec(uuid)?.[0] !== uuid) throw unavailable();
  return uuid;
}

/** A native alias allocated in the physical creation request, never repaired onto a replacement name. */
export async function readSearchWriterPhysicalTarget(
  search: OpenSearch,
  index: string,
): Promise<
  Readonly<{
    incarnation: string;
    writeAlias: string;
  }>
> {
  if (/^[a-z0-9][a-z0-9-]{0,127}subjects-g[1-9][0-9]*$/.exec(index)?.[0] !== index)
    throw new TypeError('Identity writer requires a physical subject index');
  const response = await search.request('GET', `/${index}`);
  const fail = () => new SearchUnavailableError('Native Search writer allocation is unavailable');
  if (response.status !== 200 || !record(response.body) || Object.keys(response.body).length !== 1) throw fail();
  const target = response.body[index];
  if (!record(target) || !record(target.settings) || !record(target.settings.index) || !record(target.aliases))
    throw fail();
  const incarnation = target.settings.index.uuid;
  const aliases = Object.keys(target.aliases).filter((alias) => alias.startsWith(`${index}-writer-`));
  const writeAlias = aliases[0];
  if (
    typeof incarnation !== 'string' ||
    /^[A-Za-z0-9_-]{1,128}$/.exec(incarnation)?.[0] !== incarnation ||
    aliases.length !== 1 ||
    !writeAlias ||
    !/^[a-f0-9]{32}$/.test(writeAlias.slice(`${index}-writer-`.length))
  )
    throw fail();
  const alias = target.aliases[writeAlias];
  if (!record(alias) || alias.is_write_index !== true || Object.keys(alias).length !== 1) throw fail();
  return { incarnation, writeAlias };
}
