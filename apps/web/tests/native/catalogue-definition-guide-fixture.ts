import { bundledDigest } from '@rezics/definitions/bundled';
import { releaseDigest, type Release } from '@rezics/definitions';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import historicalBundle from '../../../../packages/definitions/test/fixtures/bundled-historical-construction.json';
import { startCatalogueFactsFixture, type CatalogueFactsFixture } from './catalogue-facts-fixture.ts';

export const missingGuideDigest = `sha256:${'ab'.repeat(32)}`;

export type CatalogueDefinitionGuideFixture = CatalogueFactsFixture & {
  historicalDigest: string;
  missingDigest: string;
};

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${action}: HTTP ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

/** Facts editor plus the published historical construction; the active pointer stays bundled. */
export async function startCatalogueDefinitionGuideFixture(): Promise<CatalogueDefinitionGuideFixture> {
  const facts = await startCatalogueFactsFixture();
  try {
    const historical = historicalBundle as Release;
    const historicalDigest = releaseDigest(historical);
    if (historicalDigest === bundledDigest) throw new Error('Historical construction matches the active digest');
    if (missingGuideDigest === historicalDigest || missingGuideDigest === bundledDigest)
      throw new Error('Missing digest collides with a published release');

    const steward = await facts.stack.authPersona('steward');
    const grant = await facts.stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: steward.accountId },
          actions: ['gate:definition_publication'],
          valid: '(,)',
        }),
      },
      'governor',
    );
    if (grant.status !== 201 && grant.status !== 409)
      throw new Error(`Granting definition publication: HTTP ${grant.status} ${await grant.text()}`);

    const published = await json<{ digest: string }>(
      await facts.stack.kernel(
        '/v1/definitions/releases',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
          body: JSON.stringify({ release: historical }),
        },
        'steward',
      ),
      201,
      'POST /v1/definitions/releases',
    );
    if (published.digest !== historicalDigest)
      throw new Error(`Published ${published.digest}; expected historical ${historicalDigest}`);

    const active = await json<{ digest: string }>(
      await facts.stack.kernel('/v1/definitions/active'),
      200,
      'GET /v1/definitions/active',
    );
    if (active.digest !== bundledDigest)
      throw new Error('Publishing historical construction changed the active pointer');

    return {
      ...facts,
      historicalDigest,
      missingDigest: missingGuideDigest,
    };
  } catch (error) {
    await facts.close();
    throw error;
  }
}
