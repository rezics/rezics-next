import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import type { NativeWebStack } from './stack.ts';

export const catalogueReviewProperty = 'schema:inLanguage';
export const catalogueReviewContext = GLOBAL_CONTEXT;

type Json = Record<string, unknown>;

async function command(
  stack: NativeWebStack,
  path: string,
  body: unknown,
  persona: string,
  expected: number,
  label: string,
): Promise<Json> {
  const response = await stack.kernel(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `"${crypto.randomUUID()}"`,
      },
      body: JSON.stringify(body),
    },
    persona,
  );
  const text = await response.text();
  const value = text ? (JSON.parse(text) as Json) : {};
  if (response.status !== expected)
    throw new Error(`Native catalogue review ${label} returned ${response.status}: ${text}`);
  return value;
}

async function grant(stack: NativeWebStack, accountId: string, actions: string[]): Promise<void> {
  await command(
    stack,
    '/v1/grants',
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: accountId },
      actions,
      valid: '(,)',
    },
    'governor',
    201,
    `grant ${actions.join(',')}`,
  );
}

function languageProposal(content: string) {
  return {
    statement: {
      property: { id: catalogueReviewProperty },
      value: { type: 'value', content },
      references: [
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: `https://example.org/catalogue-review/${content}` },
            },
          ],
        },
      ],
    },
  };
}

export type CatalogueReviewCandidate = {
  id: string;
  content: string;
  label: string;
};

export type CatalogueReviewSubject = {
  id: string;
  label: string;
  href: string;
  japanese: CatalogueReviewCandidate;
  korean: CatalogueReviewCandidate;
};

export async function grantCatalogueReviewAuthority(stack: NativeWebStack): Promise<void> {
  const [alice, bob] = await Promise.all([stack.authPersona('alice'), stack.authPersona('bob')]);
  await grant(stack, alice.accountId, ['subject:create', 'statement:propose']);
  await grant(stack, bob.accountId, ['context:accept', 'context:adopt']);
}

export async function createCatalogueReviewSubject(stack: NativeWebStack): Promise<CatalogueReviewSubject> {
  const label = `Native compare ${crypto.randomUUID().slice(0, 8)}`;
  const created = await command(
    stack,
    '/v1/subjects',
    { type: 'schema:Book', labels: { en: label } },
    'editor',
    201,
    'create book',
  );
  const subject = created.subject as { id: string };
  const proposed = async (content: string, name: string) => {
    const result = await command(
      stack,
      `/v1/subjects/${subject.id}/candidates`,
      languageProposal(content),
      'alice',
      201,
      `propose ${name}`,
    );
    if (typeof result.candidate !== 'string') throw new Error(`Native proposal for ${name} returned no candidate`);
    return { id: result.candidate, content, label: name };
  };
  const japanese = await proposed('ja', 'Japanese');
  const korean = await proposed('ko', 'Korean');
  return {
    id: subject.id,
    label,
    href: subjectHref({ id: subject.id, label }, 'en').href,
    japanese,
    korean,
  };
}

export async function readPublicSubject(
  stack: NativeWebStack,
  id: string,
): Promise<{
  subject: { id: string; statements: Record<string, { id: string; rank: string; value: { content?: unknown } }[]> };
  related: Record<string, unknown>;
}> {
  const response = await stack.kernel(`/v1/subjects/${id}`);
  const text = await response.text();
  if (response.status !== 200) throw new Error(`Native public subject ${id} returned ${response.status}: ${text}`);
  return JSON.parse(text) as Awaited<ReturnType<typeof readPublicSubject>>;
}

export async function listCatalogueReviewCandidates(
  stack: NativeWebStack,
  id: string,
  persona = 'bob',
): Promise<{
  candidates: { id: string; decision: string | null; rank: string | null; head: number | null }[];
  adoption: { head: number | null };
}> {
  const response = await stack.kernel(
    `/v1/subjects/${id}/candidates?property=${encodeURIComponent(catalogueReviewProperty)}&context=${catalogueReviewContext}&limit=20`,
    {},
    persona,
  );
  const text = await response.text();
  if (response.status !== 200) throw new Error(`Native candidate list returned ${response.status}: ${text}`);
  return JSON.parse(text) as Awaited<ReturnType<typeof listCatalogueReviewCandidates>>;
}

export async function acceptCatalogueReviewCandidate(
  stack: NativeWebStack,
  subjectId: string,
  candidateId: string,
  head: number | null,
  persona: string,
): Promise<void> {
  await command(
    stack,
    `/v1/subjects/${subjectId}/candidates/${candidateId}:accept`,
    { context: catalogueReviewContext, expected_head: head },
    persona,
    200,
    'accept candidate',
  );
}

export async function adoptCatalogueReviewSelection(
  stack: NativeWebStack,
  subjectId: string,
  selection: { candidate: string; rank: 'normal' | 'preferred' }[],
  head: number | null,
  persona: string,
): Promise<void> {
  await command(
    stack,
    `/v1/subjects/${subjectId}:adopt`,
    {
      context: catalogueReviewContext,
      property: catalogueReviewProperty,
      mode: 'replace',
      selection,
      expected_head: head,
    },
    persona,
    200,
    'adopt selection',
  );
}

export function publicLanguages(
  subject: Awaited<ReturnType<typeof readPublicSubject>>['subject'],
): { id: string; rank: string; content: unknown }[] {
  return (subject.statements[catalogueReviewProperty] ?? [])
    .filter((statement) => statement.rank === 'normal' || statement.rank === 'preferred')
    .map((statement) => ({ id: statement.id, rank: statement.rank, content: statement.value.content }));
}
