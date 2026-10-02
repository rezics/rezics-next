import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { NameReceipt } from '../../../services/main/src/modules/address/registry.ts';

export async function addressFixture(label: string) {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = resolve('.temp', `g-937-${label}-${randomUUID()}`);
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    directory,
    'openid work:create work:edit work:read work:protect source:intake source:acquire source:convert source:propose source:adopt source:correspond source:read address:claim address:manage agent:create space:create zone:edit collection:edit semantic:read',
  );
  const app = createMainApp(f.env.fuseki, {
    environment: f.env,
    access: f.access,
    account: f.account.verifier,
  });
  const publicCall = (path: string, body?: object) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method: body ? 'POST' : 'GET',
        ...(body
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      }),
    );
  const lookup = (scope: string, key: string) =>
    publicCall(`/v1/addresses/resolve?${new URLSearchParams({ scope, key })}`);
  const nameWrite = (
    scope: string,
    holder: string,
    operation: 'claim' | 'rename' | 'release' | 'merge',
    name: string | null,
    expectedRevision: string | null,
    key = `name-${randomUUID()}`,
    successor?: string,
  ) =>
    f.call(
      'POST',
      `/v1/addresses/${operation === 'claim' ? 'claims' : operation === 'rename' ? 'renames' : 'dispositions'}`,
      {
        profile: 'name-write-v1',
        scope,
        holder,
        operation,
        ...(name === null ? {} : { name }),
        expectedRevision,
        actingSubject: f.actor,
        ...(successor ? { successor } : {}),
      },
      key,
    );
  let ordinal = 0;
  const work = async (title: string) => {
    const record = await f.adoptWork(await f.propose(`OL93700${++ordinal}W`, [], title));
    await f.nativeFuseki
      .update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(record.work)} rv:catalogueVisible true } }`);
    return record;
  };
  const permit = async (holder: string) => {
    for (const operation of ['claim', 'rename', 'dispose'])
      await f.grant(`address:${operation}:${holder}`, `address.${operation}`);
  };
  const receipt = (response: Response, status = 201) => f.json<NameReceipt>(response, status);
  return {
    ...f,
    publicCall,
    lookup,
    nameWrite,
    work,
    permit,
    receipt,
    close: async () => {
      await f.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
