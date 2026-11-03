import { candidateContext } from '../../src/subject/candidates.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const urlProperty = 'schema:url';

type Json = Record<string, unknown>;
export type CatalogueChangeStatement = {
  id: string;
  content: string;
  revision: number;
};
export type CatalogueChangesFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  id: string;
  label: string;
  path: string;
  createRevision: number;
  termsRevision: number;
  firstProposal: number;
  firstCandidate: string;
  firstAdoption: number;
  secondProposal: number;
  secondCandidate: string;
  secondAdoption: number;
  multiAdoption?: number;
  multiCandidates?: [string, string];
  selected: CatalogueChangeStatement;
  close(): Promise<void>;
};

async function json(response: Response, status: number, label: string): Promise<Json> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${label} returned ${response.status}: ${text}`);
  return text ? (JSON.parse(text) as Json) : {};
}

async function command(
  stack: NativeWebStack,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): Promise<Json> {
  return json(
    await stack.kernel(
      path,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          ...headers,
        },
        body: JSON.stringify(body),
      },
      'editor',
    ),
    status,
    `${method} ${path}`,
  );
}

function cited(property: string, content: string) {
  return {
    property: { id: property },
    value: { type: 'value', content },
    references: [
      {
        parts: [{ property: { id: urlProperty }, value: { type: 'value', content: 'https://example.test/evidence' } }],
      },
    ],
  };
}

async function currentSubject(stack: NativeWebStack, id: string): Promise<Json> {
  return json(await stack.kernel(`/v1/subjects/${id}`, undefined, 'editor'), 200, `GET /v1/subjects/${id}`);
}

function selectedUrl(subject: Json, content: string): CatalogueChangeStatement {
  const statements = subject.statements as Record<
    string,
    { id: string; value: { content: unknown }; rezics: { revision: number } }[]
  >;
  const row = statements[urlProperty]?.find((entry) => entry.value.content === content);
  if (!row) throw new Error(`Current reading does not include ${content}`);
  return { id: row.id, content, revision: row.rezics.revision };
}

/** Provision terms and two adoption revisions through the admitted catalogue APIs. */
export async function startCatalogueChangesFixture(
  options: { multipleSelection?: boolean } = {},
): Promise<CatalogueChangesFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    auth = await startAuthStack(stack);
    const label = `Native catalogue changes ${crypto.randomUUID().slice(0, 8)}`;
    const created = await command(
      stack,
      'POST',
      '/v1/subjects',
      { type: 'schema:Person', labels: { en: label } },
      {},
      201,
    );
    const subject = created.subject as { id?: string };
    if (typeof subject?.id !== 'string') throw new Error('Subject creation returned no id');
    const id = subject.id;
    const terms = await command(
      stack,
      'PATCH',
      `/v1/subjects/${id}/terms`,
      {
        labels: { fr: 'Personne native' },
        descriptions: { ja: '説明' },
        aliases: { de: ['Alias'] },
      },
      { 'if-match': '"1"' },
    );
    const firstUrl = `https://example.test/changes/${crypto.randomUUID().slice(0, 8)}`;
    const firstProposed = await command(
      stack,
      'POST',
      `/v1/subjects/${id}/candidates`,
      { statement: cited(urlProperty, firstUrl) },
      {},
      201,
    );
    await command(stack, 'POST', `/v1/subjects/${id}/candidates/${firstProposed.candidate}:accept`, {
      context: candidateContext,
      expected_head: null,
    });
    const firstAdopted = await command(stack, 'POST', `/v1/subjects/${id}:adopt`, {
      context: candidateContext,
      property: urlProperty,
      mode: 'replace',
      selection: [{ candidate: firstProposed.candidate, rank: 'normal' }],
      expected_head: null,
    });
    const secondUrl = `https://example.test/changes/${crypto.randomUUID().slice(0, 8)}`;
    const secondProposed = await command(
      stack,
      'POST',
      `/v1/subjects/${id}/candidates`,
      { statement: cited(urlProperty, secondUrl) },
      {},
      201,
    );
    await command(stack, 'POST', `/v1/subjects/${id}/candidates/${secondProposed.candidate}:accept`, {
      context: candidateContext,
      expected_head: null,
    });
    const secondAdopted = await command(stack, 'POST', `/v1/subjects/${id}:adopt`, {
      context: candidateContext,
      property: urlProperty,
      mode: 'replace',
      selection: [{ candidate: secondProposed.candidate, rank: 'preferred' }],
      expected_head: (firstAdopted.adoption as { head: number }).head,
    });
    let multiAdoption: number | undefined;
    let multiCandidates: [string, string] | undefined;
    if (options.multipleSelection) {
      const languageCandidates: string[] = [];
      for (const language of ['en', 'fr']) {
        const proposed = await command(
          stack,
          'POST',
          `/v1/subjects/${id}/candidates`,
          { statement: cited('schema:inLanguage', language) },
          {},
          201,
        );
        await command(stack, 'POST', `/v1/subjects/${id}/candidates/${proposed.candidate}:accept`, {
          context: candidateContext,
          expected_head: null,
        });
        languageCandidates.push(proposed.candidate as string);
      }
      const adopted = await command(stack, 'POST', `/v1/subjects/${id}:adopt`, {
        context: candidateContext,
        property: 'schema:inLanguage',
        mode: 'replace',
        selection: languageCandidates.map((candidate, index) => ({ candidate, rank: index ? 'preferred' : 'normal' })),
        expected_head: null,
      });
      multiAdoption = adopted.revision as number;
      multiCandidates = [languageCandidates[0]!, languageCandidates[1]!];
    }
    const reading = await currentSubject(stack, id);
    return {
      stack,
      auth,
      id,
      label,
      path: subjectHref({ id, label }, 'en').href,
      createRevision: 1,
      termsRevision: terms.revision as number,
      firstProposal: firstProposed.revision as number,
      firstCandidate: firstProposed.candidate as string,
      firstAdoption: firstAdopted.revision as number,
      secondProposal: secondProposed.revision as number,
      secondCandidate: secondProposed.candidate as string,
      secondAdoption: secondAdopted.revision as number,
      ...(multiAdoption !== undefined && multiCandidates ? { multiAdoption, multiCandidates } : {}),
      selected: selectedUrl(reading.subject as Json, secondUrl),
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
