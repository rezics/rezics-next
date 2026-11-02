import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { cookie, SESSION_COOKIE } from '../session/cookies';
import { csrfTokenFromRequest } from '../session/csrf';
import { sessionSubject, viewerCredential } from '../session/request';
import { normalizeLibraryLabelName } from './subject-label-name';
import { subjectLabelInputIssue } from './subject-label-input';
import { refused, statusOf, type LibraryLabelSummary, type SubjectLabelMutationResult } from './subject-labels';

/** Opaque command data, never a receipt or evidence that either native write completed. */
export type SubjectLabelStep = {
  kind: 'create' | 'assign';
  subjectId: string;
  name: string;
  token: string;
  label?: LibraryLabelSummary;
  created: boolean;
};
type Capture = {
  kind: SubjectLabelStep['kind'];
  subjectId: string;
  name: string;
  createKey: string;
  assignKey: string;
  label?: Pick<LibraryLabelSummary, 'id' | 'revision'>;
  created: boolean;
  authorization: string;
  session: string;
  viewer: string;
  csrf: string;
  sender: string;
};
const sender = (request: Request) => {
  const url = new URL(request.url);
  return url.origin + url.pathname;
};
const domain = 'rezics.subject-label-step.v1';
const tokenLimit = 3200;

// Reuse the deployment's private web credential to protect client-carried command data. No server state,
// outcome lookup or new key configuration is introduced; rotation retires existing continuations.
async function encryptionKey(env: Partial<SessionEnv>) {
  if (!env.WEBSITE_CLIENT_KEY) throw new Error('Missing web credential');
  const bytes = new TextEncoder().encode(`${domain}\n${env.WEBSITE_CLIENT_KEY}`);
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', bytes), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const decode = (token: string) =>
  Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), (value) => value.charCodeAt(0));
function context(env: Partial<SessionEnv>) {
  return new TextEncoder().encode(JSON.stringify([domain, env.AUTH_ISSUER, env.API_RESOURCE, env.WEBSITE_CLIENT_ID]));
}
async function seal(capture: Capture, env: Partial<SessionEnv>): Promise<SubjectLabelStep> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: context(env) },
      await encryptionKey(env),
      new TextEncoder().encode(JSON.stringify(capture)),
    ),
  );
  const token = encode(new Uint8Array([...iv, ...ciphertext]));
  // Leave room for the ordinary form's CSRF and intent fields under its existing transport bound.
  if (token.length > (capture.kind === 'create' ? tokenLimit - 200 : tokenLimit))
    throw new Error('Label continuation exceeds form bound');
  return {
    kind: capture.kind,
    subjectId: capture.subjectId,
    name: capture.name,
    token,
    ...(capture.label ? { label: { ...capture.label, name: capture.name } } : {}),
    created: capture.created,
  };
}
async function open(token: string, env: Partial<SessionEnv>): Promise<Capture> {
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > tokenLimit) throw new Error('Invalid label continuation');
  const bytes = decode(token);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: context(env) },
    await encryptionKey(env),
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Capture;
}

/** Resolve a name once, before any write. Repeating a lost preparation response cannot repeat a write. */
export async function prepareSubjectLabelStep(
  request: Request,
  env: Partial<SessionEnv>,
  input: {
    subjectId: string;
    idempotencyKey: string;
  } & (
    | { intent: 'create-and-assign'; name: string; createKey?: string }
    | { intent: 'capture-assign'; labelId: string }
  ),
  client: KernelClient,
): Promise<SubjectLabelMutationResult> {
  const authorization = viewerCredential(request);
  const session = cookie(request, SESSION_COOKIE);
  const viewer = sessionSubject(request);
  const csrf = await csrfTokenFromRequest(request);
  if (!authorization || !session || !viewer || !csrf) return { ok: false, reason: 'signed-out' };
  let label: LibraryLabelSummary | undefined;
  let name = '';
  if (input.intent === 'create-and-assign') {
    if (!input.createKey || subjectLabelInputIssue(input.name)) return { ok: false, reason: 'unavailable' };
    name = normalizeLibraryLabelName(input.name);
    const search = await client.libraryLabels.get({ query: { q: input.name, limit: 20 }, headers: { authorization } });
    if (search.error || !search.data || (statusOf(search) ?? 500) >= 400) return refused(search, input.intent);
    label = search.data.labels.find((item) => normalizeLibraryLabelName(item.name) === name);
  } else label = { id: input.labelId, name, revision: 1 };
  const step = await seal(
    {
      kind: label ? 'assign' : 'create',
      subjectId: input.subjectId,
      name,
      createKey: input.intent === 'create-and-assign' ? input.createKey! : '',
      assignKey: input.idempotencyKey,
      ...(label ? { label: { id: label.id, revision: label.revision } } : {}),
      created: false,
      authorization,
      session,
      viewer,
      csrf,
      sender: sender(request),
    },
    env,
  );
  return { ok: false, reason: 'continue', step };
}

/** Dispatch exactly one captured native command. A successful create supplies the next exact assignment. */
export async function executeSubjectLabelStep(
  request: Request,
  env: Partial<SessionEnv>,
  input: {
    subjectId: string;
    token: string;
  },
  client: KernelClient,
): Promise<SubjectLabelMutationResult> {
  const capture = await open(input.token, env);
  if (
    sender(request) !== capture.sender ||
    input.subjectId !== capture.subjectId ||
    cookie(request, SESSION_COOKIE) !== capture.session ||
    sessionSubject(request) !== capture.viewer ||
    (await csrfTokenFromRequest(request)) !== capture.csrf
  )
    return { ok: false, reason: 'signed-out' };
  const headers = {
    authorization: capture.authorization,
    'idempotency-key': capture.kind === 'create' ? capture.createKey : capture.assignKey,
  };
  if (capture.kind === 'create') {
    const result = await client.libraryLabels.post({ name: capture.name }, { headers });
    if (result.error || !result.data || (statusOf(result) ?? 500) >= 400) return refused(result, 'create-and-assign');
    const label = result.data.label;
    const step = await seal({ ...capture, kind: 'assign', label, created: true }, env);
    return { ok: false, reason: 'continue', step };
  }
  if (!capture.label) return { ok: false, reason: 'unavailable' };
  const result = await client
    .libraryLabels({ id: capture.label.id })
    .$assign.post({ subjectId: capture.subjectId }, { headers });
  if (result.error || !result.data || (statusOf(result) ?? 500) >= 400) return refused(result, 'assign');
  return { ok: true, label: { ...capture.label, name: capture.name }, assignment: result.data.assignment };
}

/** Reveal continuation display only to the same currently admitted session, without a command or catalogue read. */
export async function readSubjectLabelStep(
  request: Request,
  env: Partial<SessionEnv>,
  input: {
    subjectId: string;
    token: string;
  },
): Promise<SubjectLabelStep | null> {
  try {
    const capture = await open(input.token, env);
    if (
      sender(request) !== capture.sender ||
      input.subjectId !== capture.subjectId ||
      cookie(request, SESSION_COOKIE) !== capture.session ||
      sessionSubject(request) !== capture.viewer ||
      (await csrfTokenFromRequest(request)) !== capture.csrf
    )
      return null;
    return {
      kind: capture.kind,
      subjectId: capture.subjectId,
      name: capture.name,
      token: input.token,
      ...(capture.label ? { label: { ...capture.label, name: capture.name } } : {}),
      created: capture.created,
    };
  } catch {
    return null;
  }
}
