import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type CatalogueTermsSubject = {
  id: string;
  label: string;
  path: string;
  termsPath: string;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
};

export type CatalogueTermsFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  createSubject(label: string): Promise<CatalogueTermsSubject>;
  close(): Promise<void>;
};

type Created = { subject?: { id?: string } };

/** Provision ordinary catalogue subjects through the released native create API. */
export async function startCatalogueTermsFixture(): Promise<CatalogueTermsFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    auth = await startAuthStack(stack);
    const active = await stack.kernel('/v1/definitions/active');
    if (!active.ok) throw new Error(`Active definitions read failed: ${active.status} ${await active.text()}`);
    const release = (await active.json()) as { digest?: string };
    if (release.digest !== bundledDigest) throw new Error('Native stack is not using the bundled definition release');
    if (!bundledRelease.types['schema:Book']) throw new Error('Bundled definition release has no schema:Book');
    const alice = await stack.authPersona('alice');
    const grant = await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: alice.accountId },
          actions: ['statement:propose'],
          valid: '(,)',
        }),
      },
      'governor',
    );
    if (grant.status !== 201 && grant.status !== 409)
      throw new Error(`Granting statement:propose to Alice: HTTP ${grant.status} ${await grant.text()}`);

    return {
      stack,
      auth,
      createSubject: (label) => createSubject(stack, label),
      async close() {
        await auth?.stop();
        await stack.stop();
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop();
    throw error;
  }
}

async function createSubject(stack: NativeWebStack, label: string): Promise<CatalogueTermsSubject> {
  const labels = { en: label, ja: `元の題名 ${label.slice(-8)}` };
  const descriptions = {
    en: 'An original native description.',
    ja: '元の説明',
  };
  const aliases = { en: ['Original alias'], ja: ['元の別名'] };
  const created = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      body: JSON.stringify({ type: 'schema:Book', labels, descriptions, aliases }),
    },
    'editor',
  );
  if (created.status !== 201) throw new Error(`Subject creation failed: ${created.status} ${await created.text()}`);
  const result = (await created.json()) as Created;
  const id = result.subject?.id;
  if (typeof id !== 'string') throw new Error('Subject creation returned no id');
  const path = subjectHref({ id, label }, 'en').href;
  return { id, label, path, termsPath: `${path}/terms`, labels, descriptions, aliases };
}
