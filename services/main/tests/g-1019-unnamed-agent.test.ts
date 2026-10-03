import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { uuidToSid } from '@rezics/model/address';
import type { PoolClient } from 'pg';
import { agentAddress, agentForHandle } from '../src/modules/agent/handle.ts';
import { profileHandle } from '../src/modules/profiles/read-contract.ts';
import { resolveAgentSearch } from '../src/modules/access/realm-management-search.ts';

const id = '71473997-13ae-4000-8000-123456789abc';
const agent = `https://rezics.com/id/${id}`;
test('G-1019: public handles admit null or a chosen name, never the legacy identifier', () => {
  expect(Value.Check(profileHandle, null)).toBe(true);
  expect(Value.Check(profileHandle, 'lin_mei')).toBe(true);
  expect(Value.Check(profileHandle, `agent-${id}`)).toBe(false);
  expect(agentAddress(agent, null)).toEqual({ prefix: '/a/', key: uuidToSid(id), suffixSource: '' });
  expect(agentAddress(agent, 'lin_mei')).toEqual({ prefix: '/@', key: 'lin_mei', suffixSource: '' });
  expect(agentForHandle(`AGENT-${id.toUpperCase()}`)).toBe(agent);
});

test('G-1019: management searches resolve exact sids, UUIDs and retained names before text search', async () => {
  const queries: unknown[][] = [];
  const client = {
    query: async (_sql: string, args: unknown[]) => {
      queries.push(args);
      return { rows: args[0] === 'old_name' ? [{ holder: agent }] : [] };
    },
  } as unknown as PoolClient;
  for (const key of [uuidToSid(id), id.toUpperCase(), agent])
    expect(await resolveAgentSearch(client, key)).toBe(agent);
  expect(queries).toHaveLength(0);
  expect(await resolveAgentSearch(client, 'Old_Name')).toBe(agent);
  expect(await resolveAgentSearch(client, '王')).toBe('王');
  expect(await resolveAgentSearch(client, '_%\\')).toBe('_%\\');
});
