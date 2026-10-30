import { subjectAlias, subjectIndexName } from '../../../src/search/indices.ts';
import type { OpenSearch } from '../../../src/search/opensearch.ts';

export type MetadataReceipt = { status: number; body: unknown };
export type MetadataControl = { name: string; corrupt(receipt: MetadataReceipt): void };
type ResolveBody = {
  indices: { name: unknown; attributes?: unknown; aliases?: unknown; data_stream?: unknown }[];
  aliases: { name: unknown; indices?: unknown }[];
  data_streams: unknown;
};

export function captureMetadata(
  native: OpenSearch,
  surface: 'resolve' | 'mapping',
  control?: MetadataControl,
  occurrence = 1,
) {
  const calls: { method: string; path: string; raw?: MetadataReceipt; changed?: MetadataReceipt }[] = [];
  let observations = 0;
  const client: OpenSearch = {
    bulk: (...args) => native.bulk(...args),
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const call: (typeof calls)[number] = { method: args[0], path: args[1] };
      calls.push(call);
      const response = await native.request<T>(...args);
      call.raw = structuredClone(response);
      const matches = surface === 'resolve' ? args[1].startsWith('/_resolve/index/') : args[1].endsWith('/_mapping');
      if (matches && ++observations === occurrence && control) {
        const changed: MetadataReceipt = structuredClone(response);
        control.corrupt(changed);
        call.changed = changed;
        console.info('native metadata boundary', JSON.stringify({ control: control.name, ...call }));
        return changed as { status: number; body: T };
      }
      return response;
    },
  };
  return { client, calls };
}

// Every control is applied only to a clone of a response obtained from the native
// node by the caller. These types describe the established baseline, not fixtures.
export function resolveControls(prefix: string): MetadataControl[] {
  const alias = subjectAlias(prefix);
  const first = subjectIndexName(prefix, 1);
  const second = subjectIndexName(prefix, 2);
  const controls: MetadataControl[] = [];
  const change = (name: string, edit: (body: ResolveBody) => void) =>
    controls.push({ name, corrupt: (receipt) => edit(receipt.body as ResolveBody) });
  for (const status of [201, 204, 206, 302, 500])
    controls.push({ name: `resolve HTTP ${status}`, corrupt: (receipt) => { receipt.status = status; } });
  for (const value of [null, [], 'metadata', 1])
    controls.push({ name: `resolve body ${JSON.stringify(value)}`, corrupt: (receipt) => { receipt.body = value; } });
  for (const field of ['indices', 'aliases', 'data_streams'] as const) {
    change(`missing ${field}`, (body) => { delete (body as Partial<ResolveBody>)[field]; });
    for (const value of [null, {}, 'records'])
      change(`${field} ${JSON.stringify(value)}`, (body) => { (body as unknown as Record<string, unknown>)[field] = value; });
  }
  change('successful body with error', (body) => { (body as unknown as Record<string, unknown>).error = { type: 'partial_response' }; });
  for (const value of [null, [], 'index'])
    change(`index record ${JSON.stringify(value)}`, (body) => { body.indices[0] = value as never; });
  change('missing physical name', (body) => { delete (body.indices[0] as { name?: unknown }).name; });
  for (const name of [null, 1, '', alias, `${prefix}subjects-other`, 'foreign-subjects-g1',
    ...['0', '-1', '01', '+1', '1.5', '1e2', '9007199254740992', '9'.repeat(100)].map((suffix) => `${alias}-g${suffix}`)])
    change(`physical name ${JSON.stringify(name)}`, (body) => { body.indices[0]!.name = name; });
  change('identical duplicate physical name', (body) => { body.indices.push(structuredClone(body.indices[0]!)); });
  change('contradictory duplicate physical name', (body) => { body.indices.push({ name: first, attributes: ['closed'] }); });
  change('over generation cap', (body) => {
    body.indices.push({ name: subjectIndexName(prefix, 3), attributes: ['open'] }, { name: subjectIndexName(prefix, 4), attributes: ['open'] });
  });
  change('missing attributes', (body) => { delete body.indices[0]!.attributes; });
  for (const attributes of [null, 'open', [], ['hidden'], ['closed'], ['open', 'closed'], ['open', 'frozen'], ['open', 'other'], ['open', 'open'], ['open', null]])
    change(`attributes ${JSON.stringify(attributes)}`, (body) => { body.indices[0]!.attributes = attributes; });
  for (const aliases of [null, alias, [null], ['foreign-alias'], [alias, alias]])
    change(`physical aliases ${JSON.stringify(aliases)}`, (body) => { body.indices[0]!.aliases = aliases; });
  change('missing reverse alias membership', (body) => { delete body.indices[0]!.aliases; });
  change('wrong reverse alias membership', (body) => { delete body.indices[0]!.aliases; body.indices[1]!.aliases = [alias]; });
  change('multiple reverse alias memberships', (body) => { body.indices[1]!.aliases = [alias]; });
  for (const data_stream of [null, 'stream'])
    change(`physical data stream ${JSON.stringify(data_stream)}`, (body) => { body.indices[0]!.data_stream = data_stream; });
  change('unexpected data stream', (body) => { body.data_streams = [{ name: alias, backing_indices: [first], timestamp_field: '@timestamp' }]; });
  for (const value of [null, [], 'alias'])
    change(`alias record ${JSON.stringify(value)}`, (body) => { body.aliases[0] = value as never; });
  change('missing alias name', (body) => { delete (body.aliases[0] as { name?: unknown }).name; });
  for (const name of [null, 1, '', `${alias}-other`, 'foreign-subjects'])
    change(`alias name ${JSON.stringify(name)}`, (body) => { body.aliases[0]!.name = name; });
  change('missing alias receipt', (body) => { body.aliases = []; });
  change('missing alias targets', (body) => { delete body.aliases[0]!.indices; });
  for (const targets of [null, first, [], [null], [{}], [first, second], [first, first], [second], [subjectIndexName(prefix, 3)], ['foreign-subjects-g1'], [`${alias}-g01`], [`${alias}-g9007199254740992`]])
    change(`alias targets ${JSON.stringify(targets)}`, (body) => { body.aliases[0]!.indices = targets; });
  change('identical duplicate alias', (body) => { body.aliases.push(structuredClone(body.aliases[0]!)); });
  change('contradictory duplicate alias', (body) => { body.aliases.push({ name: alias, indices: [second] }); });
  change('foreign extra alias', (body) => { body.aliases.push({ name: 'foreign-subjects', indices: [first] }); });
  change('target missing from namespace', (body) => { body.indices.shift(); });
  return controls;
}

export function mappingControls(index: string): MetadataControl[] {
  const controls: MetadataControl[] = [];
  type MappingBody = Record<string, { mappings: { _meta?: unknown; properties?: unknown } }>;
  const change = (name: string, edit: (body: MappingBody) => void) =>
    controls.push({ name, corrupt: (receipt) => edit(receipt.body as MappingBody) });
  for (const status of [201, 204, 206, 302, 500])
    controls.push({ name: `mapping HTTP ${status}`, corrupt: (receipt) => { receipt.status = status; } });
  for (const value of [null, [], 'mapping', {}])
    controls.push({ name: `mapping body ${JSON.stringify(value)}`, corrupt: (receipt) => { receipt.body = value; } });
  change('missing mapping identity', (body) => { body['foreign-subjects-g1'] = body[index]!; delete body[index]; });
  change('extra mapping identity', (body) => { body['foreign-subjects-g1'] = structuredClone(body[index]!); });
  for (const value of [null, [], 'index', {}])
    change(`mapping index ${JSON.stringify(value)}`, (body) => { body[index] = value as never; });
  for (const value of [null, [], 'mappings'])
    change(`mappings ${JSON.stringify(value)}`, (body) => { body[index]!.mappings = value as never; });
  change('missing mapping properties', (body) => { delete body[index]!.mappings.properties; });
  for (const value of [null, [], 'properties'])
    change(`mapping properties ${JSON.stringify(value)}`, (body) => { body[index]!.mappings.properties = value; });
  for (const value of [null, [], 'meta'])
    change(`mapping meta ${JSON.stringify(value)}`, (body) => { body[index]!.mappings._meta = value; });
  for (const value of [null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    change(`mapping format ${JSON.stringify(value)}`, (body) => { body[index]!.mappings._meta = { name_sort_format: value }; });
  return controls;
}
