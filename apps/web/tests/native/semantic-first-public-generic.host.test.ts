import { bundledDigest } from '@rezics/definitions/bundled';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAndRead, type SemanticBrowserSession } from '../../scripts/semantic-first-public-browser.ts';
import { readActiveDefinitions, requireStatus, type Json } from '../../scripts/semantic-first-public-native.ts';
import {
  nativeWalkCall,
  summarizeBoundaryRequest,
  type NativeObservation,
} from '../../scripts/semantic-first-public-request.ts';
import { prepareNativeAuthMessages, startAuthStack } from './auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import { startNativeWebStack } from './stack.ts';

const lifecycle = new NativeTestLifecycle('original Semantic generic Book native Web host');
const evidenceDir = resolve(import.meta.dir, '../../../../.temp/semantic-first-public-native-host');
const evidencePath = resolve(evidenceDir, 'evidence.json');
const root = resolve(import.meta.dir, '../../../..');
const trace: NativeObservation[] = [];
let session: SemanticBrowserSession;
let sourceRevision: string | null = null;
let stage = 'preparing';
let editorAccountId: string;
let result: {
  id: 'generic-creation';
  status: 'Passing' | 'Failing';
  ms?: number;
  native?: unknown;
  browser?: unknown;
  failure?: string;
} | null = null;

async function retain() {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        revision: sourceRevision,
        utc: new Date().toISOString(),
        scope: 'original-generic-creation-native-host',
        phase: stage,
        editorAccountId,
        result,
        mountedSubject: session?.mountedSubject,
        commands: trace.map(summarizeBoundaryRequest),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}

nativeBeforeAll(lifecycle, 600_000, async () => {
  await mkdir(resolve(evidenceDir, 'screenshots'), { recursive: true, mode: 0o700 });
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  sourceRevision = revision.exitCode === 0 ? revision.stdout.toString().trim() : null;
  await retain();
  try {
    await prepareNativeAuthMessages();
    stage = 'native Web stack';
    const stack = await startNativeWebStack();
    const call = nativeWalkCall(stack.kernelOrigin, trace);
    stage = 'active Definitions';
    const release = await readActiveDefinitions(call);
    if (release.digest !== bundledDigest) throw new Error('Native Web stack did not activate the bundled Definitions');

    stage = 'ordinary native editor';
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
    editorAccountId = editor.accountId;

    stage = 'mounted Auth sign-in';
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

    stage = 'current editor credential';
    const credential = await stack.authPersona('editor', ['subject:create']);
    if (credential.accountId !== editorAccountId || !credential.authorization.startsWith('Bearer '))
      throw new Error('Current native editor credential changed its account');
    session = {
      stack: {
        web: new URL(stack.web).origin,
        issuer: auth.origin,
        native: stack.authIssuer,
        kernel: stack.kernelOrigin,
      },
      call,
      editor: credential.authorization.slice('Bearer '.length),
      member: signedIn.context,
      anonymous: await auth.newContext('anonymous'),
      evidenceDir,
    };
    stage = 'ready';
  } finally {
    await retain();
  }
});
nativeAfterAll(lifecycle, 240_000);

nativeTest(
  'original generic Semantic Book creation visits the signed form and anonymous reader',
  720_000,
  async () => {
    const started = performance.now();
    stage = 'original generic Book case';
    try {
      const observed = await createAndRead(
        session,
        'schema:Book',
        `Walk book ${crypto.randomUUID().slice(0, 8)}`,
        '/en/catalogue/new',
        true,
      );
      result = { id: 'generic-creation', status: 'Passing', ms: Math.round(performance.now() - started), ...observed };
      stage = 'completed';
    } catch (error) {
      result = {
        id: 'generic-creation',
        status: 'Failing',
        ms: Math.round(performance.now() - started),
        failure: (error instanceof Error ? error.message : String(error)).slice(0, 800),
      };
      throw error;
    } finally {
      await retain();
    }
  },
  lifecycle,
);
