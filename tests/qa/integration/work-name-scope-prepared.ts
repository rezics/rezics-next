import { expect } from 'bun:test';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { startMediaStack } from './media-support.ts';

const REPAIR = 'urn:rezics:projection:public-name-repair';
const DIRECTORY = 'urn:rezics:search:name:work-scope-directory';
const PHASE = 'https://rezics.com/vocab/scopePhase';

export async function workNameScopePhase(fuseki: FusekiClient): Promise<string | undefined> {
  const rows = (await fuseki.query(`SELECT ?phase WHERE {
    GRAPH <${REPAIR}> { <${DIRECTORY}> <${PHASE}> ?phase }
  }`)).results?.bindings ?? [];
  return rows.length === 1 ? rows[0]!.phase?.value : undefined;
}

/** The directory is already complete, and a Work header read succeeds. */
export async function assertPreparedWorkRead(label: string): Promise<void> {
  const stack = await startMediaStack(label);
  try {
    expect(await workNameScopePhase(stack.fuseki)).toBe('complete');
    const member = await stack.member(`${label} reader`);
    const created = await stack.publicWork(member.actor, ['en'], `${label} work`);
    const response = await stack.main.handle(new Request(
      `http://main.local/v1/works/${created.work.slice(-36)}`,
    ));
    const body = await response.json() as { profile?: string; title?: { value?: string } };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.profile).toBe('work-read-v1');
    expect(body.title?.value).toBe(`${label} work`);
  } finally {
    await stack.stop();
  }
}
