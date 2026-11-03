import { bundledDigest } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { createSubject, waitForSuggestion, type NativeCatalogueSubject } from './catalogue-relations-fixture.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type NativeStoryArcFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: AuthJourney;
  parent: NativeCatalogueSubject;
  volume: NativeCatalogueSubject;
  season: NativeCatalogueSubject;
  release: NativeCatalogueSubject;
  close(): Promise<void>;
};

const writeRateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 1000, seconds: 60 } },
  member: { write: { maximum: 1000, seconds: 60 } },
  trusted: { write: { maximum: 1000, seconds: 60 } },
  service: { write: { maximum: 1000, seconds: 60 } },
});

export async function startCatalogueStoryArcFixture(): Promise<NativeStoryArcFixture> {
  const stack = await startNativeWebStack({ writeRateOverrides });
  let auth: NativeAuthStack | undefined;
  try {
    const active = await stack.kernel('/v1/definitions/active');
    const digest = ((await active.json()) as { digest: string }).digest;
    if (active.status !== 200 || digest !== bundledDigest)
      throw new Error(`Native stack activated ${digest}; expected bundled release ${bundledDigest}.`);

    const aliceIdentity = await stack.authPersona('alice');
    const grant = await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: aliceIdentity.accountId },
          actions: ['statement:propose', 'context:accept', 'context:adopt'],
          valid: '(,)',
        }),
      },
      'governor',
    );
    if (grant.status !== 201 && grant.status !== 409)
      throw new Error(`Granting story-arc authority to Alice: HTTP ${grant.status} ${await grant.text()}`);

    const marker = crypto.randomUUID().slice(0, 8);
    const parent = await createSubject(stack, 'schema:TVSeries', `Native story-arc parent ${marker}`);
    const volume = await createSubject(stack, 'schema:PublicationVolume', `Native story-arc volume ${marker}`);
    const season = await createSubject(stack, 'schema:TVSeason', `Native story-arc season ${marker}`);
    const release = await createSubject(stack, 'rezics:AnimeRelease', `Native story-arc release ${marker}`);
    await waitForSuggestion(stack, parent);

    auth = await startAuthStack(stack);
    const alice = await auth.signIn('alice');
    return {
      stack,
      auth,
      alice,
      parent,
      volume,
      season,
      release,
      async close() {
        await auth?.stop();
        await stack.stop();
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}
