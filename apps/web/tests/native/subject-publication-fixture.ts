import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type SubjectPublicationFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  subject: { id: string; label: string; path: string };
  close(): Promise<void>;
};

/** Provision a public subject through the active released catalogue API on a real native stack. */
export async function startSubjectPublicationFixture(): Promise<SubjectPublicationFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    auth = await startAuthStack(stack);
    const active = await stack.kernel('/v1/definitions/active');
    if (!active.ok) throw new Error(`Active definitions read failed: ${active.status} ${await active.text()}`);
    const release = (await active.json()) as { digest?: string };
    if (release.digest !== bundledDigest) throw new Error(`Native stack is not using the bundled definition release`);
    if (!bundledRelease.types['schema:Book']) throw new Error('Bundled definition release has no schema:Book');

    const label = `Attributable subject ${crypto.randomUUID()}`;
    const created = await stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({
          type: 'schema:Book',
          labels: { en: label, 'zh-Hans': `可归属条目 ${label.slice(-8)}` },
          descriptions: { en: 'A public description created through the released catalogue API.' },
        }),
      },
      'editor',
    );
    if (!created.ok) throw new Error(`Subject creation failed: ${created.status} ${await created.text()}`);
    const result = (await created.json()) as { subject?: { id?: string } };
    if (typeof result.subject?.id !== 'string') throw new Error('Subject creation returned no id');
    const path = subjectHref({ id: result.subject.id, label }, 'en').href;

    return {
      stack,
      auth,
      subject: { id: result.subject.id, label, path },
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
