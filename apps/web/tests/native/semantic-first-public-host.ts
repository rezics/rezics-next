import { bundledDigest } from '@rezics/definitions/bundled';
import { semanticWalkClientRegistration } from '../../../../services/auth/scripts/dev-stack.ts';
import type { SemanticFirstPublicSession } from '../../scripts/semantic-first-public-cases.ts';
import {
  readActiveDefinitions,
  requireStatus,
  resolveEditorAgent,
  type Json,
} from '../../scripts/semantic-first-public-native.ts';
import { nativeWalkCall, type NativeObservation } from '../../scripts/semantic-first-public-request.ts';
import { prepareNativeAuthMessages, startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';
import { prepareNativeWebSearch } from './search-fixture.ts';

/** Original case bodies use one ordinary native Web/Auth/Kernel fixture and its real editor. */
export async function prepareSemanticFirstPublicHost(
  evidenceDir: string,
  revision: string,
  trace: NativeObservation[],
  stage: (value: string) => void,
  allCases = false,
  services: { search?: boolean } = {},
) {
  await prepareNativeAuthMessages();
  if (services.search) {
    stage('native Search service');
    await prepareNativeWebSearch('semantic-first-public');
  }
  stage('native Web stack');
  const stack = await startNativeWebStack({ semanticFirstPublicEditor: allCases });
  if (services.search && (!stack.searchWorker?.prefix || !stack.searchWorker.executorId))
    throw new Error('Selected Semantic catalogue browsing requires the configured native Search worker');
  const call = nativeWalkCall(stack.kernelOrigin, trace);
  stage('active Definitions');
  const release = await readActiveDefinitions(call);
  if (release.digest !== bundledDigest) throw new Error('Native Web stack did not activate the bundled Definitions');

  stage('ordinary native editor');
  const editor = await stack.authPersona('editor');
  const current = requireStatus(
    await call('GET', '/v1/accounts', { query: { ids: editor.accountId } }),
    200,
    'current ordinary editor',
  );
  const accounts = current.accounts as Json[] | undefined;
  if (
    !Array.isArray(accounts) ||
    accounts.length !== 1 ||
    accounts[0]?.id !== editor.accountId ||
    accounts[0].state !== 'active' ||
    accounts[0].kind !== 'actor' ||
    accounts[0].automated !== false
  )
    throw new Error('Native editor did not match one current ordinary account');
  const editorAccountId = editor.accountId;

  stage('mounted Auth sign-in');
  const auth = await startAuthStack(stack, { preparedMessages: true, useHeadlessShell: true });
  const signedIn = await auth.signIn('editor', { returnTo: '/en/catalogue/new' });
  if ((await signedIn.response()).status() !== 200 || new URL(signedIn.url).pathname !== '/en/catalogue/new')
    throw new Error('Ordinary editor did not return from Auth to the original catalogue form');
  const identity = await signedIn.context.request.post(new URL('/account-identity', auth.origin).href, {
    headers: { origin: auth.origin },
    data: {},
    maxRedirects: 0,
    timeout: 30_000,
  });
  if (identity.status() !== 200 || (await identity.json())?.account_id !== editorAccountId)
    throw new Error('Browser Auth account did not match the native editor');
  await signedIn.continueOnPage().close();

  stage('current editor credential');
  const scopes = allCases ? semanticWalkClientRegistration().scopes : ['subject:create'];
  const credential = await stack.authPersona('editor', scopes);
  if (credential.accountId !== editorAccountId || !credential.authorization.startsWith('Bearer '))
    throw new Error('Current native editor credential changed its account');
  let editorIssued = Date.now();
  const session: SemanticFirstPublicSession = {
    stack: {
      web: new URL(stack.web).origin,
      issuer: auth.origin,
      native: stack.authIssuer,
      kernel: stack.kernelOrigin,
    },
    call,
    trace,
    revision,
    editor: credential.authorization.slice('Bearer '.length),
    member: signedIn.context,
    anonymous: await auth.newContext('anonymous'),
    evidenceDir,
    async verifyMember(page) {
      try {
        const identity = await page.evaluate(async () => {
          const { sessionQuery } = await import(new URL('/src/session/query.ts', location.href).href);
          const result = await sessionQuery.queryFn();
          return { state: result.state, subject: result.subject };
        });
        if (identity.state === 'signed-out') return 'signed-out';
        if (identity.state !== 'signed-in') return 'unavailable';
        return identity.subject === editorAccountId ? 'matched' : 'different-reader';
      } catch {
        return 'unavailable';
      }
    },
    editorAgent: () => resolveEditorAgent(call, session.editor, editorAccountId),
    async refreshEditor() {
      if (Date.now() - editorIssued < 240_000) return;
      const refreshed = await stack.authPersona('editor', scopes);
      if (refreshed.accountId !== editorAccountId || !refreshed.authorization.startsWith('Bearer '))
        throw new Error('Refreshed native editor credential changed its account');
      session.editor = refreshed.authorization.slice('Bearer '.length);
      editorIssued = Date.now();
    },
  };
  if (allCases) {
    stage('current native editor Agent');
    await session.editorAgent();
  }
  stage('ready');
  return { session, editorAccountId, searchWorker: stack.searchWorker };
}
