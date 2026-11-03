import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../kernel/client';
import { locales } from '../../paraglide/runtime.js';
import { candidateAuthorization } from '../../subject/candidate-admission';
import { isRecord } from './shared';
import {
  connectionGroups,
  readConnectionVisit,
  type ConnectionAddress,
  type ConnectionGroup,
  type ConnectionSelection,
  type ConnectionVisit,
} from './subject-connections';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Closed Web address; properties are admitted again from the current release, not trusted as grants. */
export function connectionAddress(value: unknown): ConnectionAddress {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['id', 'locale', 'realm', 'viewer', 'context', 'release', 'selection', 'graph', 'only'].includes(key),
    ) ||
    typeof value.id !== 'string' ||
    !uuid.test(value.id) ||
    typeof value.locale !== 'string' ||
    !locales.includes(value.locale as never)
  )
    throw new Error('Invalid connections address');
  for (const key of ['realm', 'viewer', 'context']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !uuid.test(value[key])))
      throw new Error('Invalid connections identity');
  }
  if (value.release !== undefined && (typeof value.release !== 'string' || !/^[a-f0-9]{64}$/.test(value.release)))
    throw new Error('Invalid connections release');
  if (value.only !== undefined && !connectionGroups.includes(value.only as ConnectionGroup))
    throw new Error('Invalid connections group');
  let selection: ConnectionAddress['selection'];
  if (value.selection !== undefined) {
    if (
      !isRecord(value.selection) ||
      Object.keys(value.selection).some((key) => !connectionGroups.includes(key as ConnectionGroup))
    )
      throw new Error('Invalid connections selection');
    selection = {};
    for (const group of connectionGroups) {
      const selected = value.selection[group];
      if (selected === undefined) continue;
      if (
        !isRecord(selected) ||
        Object.keys(selected).some((key) => key !== 'stream' && key !== 'cursor') ||
        typeof selected.stream !== 'string' ||
        !selected.stream ||
        selected.stream.length > 512 ||
        (selected.cursor !== undefined &&
          (typeof selected.cursor !== 'string' || !selected.cursor || selected.cursor.length > 32768))
      )
        throw new Error('Invalid connections continuation');
      selection[group] = selected as ConnectionSelection;
    }
  }
  let graph: ConnectionAddress['graph'];
  if (value.graph !== undefined) {
    if (
      !isRecord(value.graph) ||
      Object.keys(value.graph).some((key) => key !== 'properties' && key !== 'depth') ||
      (value.graph.depth !== 1 && value.graph.depth !== 2) ||
      !Array.isArray(value.graph.properties) ||
      value.graph.properties.length < 1 ||
      value.graph.properties.length > 8 ||
      new Set(value.graph.properties).size !== value.graph.properties.length ||
      value.graph.properties.some((property) => typeof property !== 'string' || !property || property.length > 256)
    )
      throw new Error('Invalid connections graph');
    graph = { properties: value.graph.properties, depth: value.graph.depth };
  }
  return {
    id: value.id,
    locale: value.locale,
    realm: value.realm as string | undefined,
    viewer: value.viewer as string | undefined,
    context: value.context as string | undefined,
    release: value.release as string | undefined,
    only: value.only as ConnectionGroup | undefined,
    selection,
    graph,
  };
}

export const loadSubjectConnections = createServerFn({ method: 'GET', strict: false })
  .validator(connectionAddress)
  .handler(async ({ data }): Promise<ConnectionVisit> => {
    setResponseHeader('cache-control', 'private, no-store');
    let authorization: string | undefined;
    if (data.viewer !== undefined) {
      authorization = (await candidateAuthorization(data.viewer)) ?? undefined;
      if (!authorization) return { ok: false, status: 401 };
    }
    return readConnectionVisit(kernelClient(data.locale), data, authorization, getRequest().signal);
  });
