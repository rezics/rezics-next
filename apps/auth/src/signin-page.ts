import { privateAuthRead } from './private-auth-read';
import { readJsonBounded } from './private-auth-json';

export type SignInPageViewer = { kind: 'signed-out' } | { kind: 'signed-in'; account_id: string; email: string | null };

export type SignInPage = {
  methods: { password: boolean; passkey: boolean };
  viewer: SignInPageViewer;
  continuation: { href: string; requires_sign_in: boolean };
};

export type SignInPageResult = { kind: 'ready'; page: SignInPage } | { kind: 'unavailable' };
export type SignInPageReadOwner = {
  beginPageRead(): {
    finish(): boolean;
    retire(): void;
  } | null;
};

const maxQueryBytes = 4096;
const maxResponseBytes = 16384;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const continuationPaths = new Set(['/authorize', '/consent', '/security', '/account/delete', '/organizations/new']);
const encoder = new TextEncoder();

/** One no-store native read. The only request data is the current route query;
 * an entered email never participates in method or session advice.
 */
export async function loadSignInPage(query: string, origin: string, caller?: AbortSignal): Promise<SignInPageResult> {
  if (encoder.encode(query).byteLength > maxQueryBytes) return { kind: 'unavailable' };
  try {
    const page = await privateAuthRead(async (signal) => {
      const response = await fetch('/signin/page', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query }),
        signal,
      });
      if (response.status !== 200) return null;
      return parseSignInPage(await readJsonBounded(response, maxResponseBytes, signal), origin);
    }, caller);
    return page ? { kind: 'ready', page } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** A late response cannot restore a previous route's or account's page advice. */
export async function loadSignInPageForJourney(
  query: string,
  origin: string,
  owner: SignInPageReadOwner,
  caller?: AbortSignal,
): Promise<SignInPageResult | null> {
  const read = owner.beginPageRead();
  if (!read) return null;
  try {
    const result = await loadSignInPage(query, origin, caller);
    return read.finish() ? result : null;
  } finally {
    read.retire();
  }
}

export function parseSignInPage(value: unknown, origin: string): SignInPage | null {
  if (!record(value) || keys(value) !== 'continuation,methods,viewer') return null;
  const { continuation, methods, viewer } = value;
  if (
    !record(methods) ||
    keys(methods) !== 'passkey,password' ||
    typeof methods.password !== 'boolean' ||
    typeof methods.passkey !== 'boolean' ||
    !record(continuation) ||
    keys(continuation) !== 'href,requires_sign_in' ||
    typeof continuation.href !== 'string' ||
    encoder.encode(continuation.href).byteLength > 12288 ||
    typeof continuation.requires_sign_in !== 'boolean'
  )
    return null;

  let safeContinuation: URL;
  try {
    if (!continuation.href.startsWith('/') || continuation.href.startsWith('//')) return null;
    safeContinuation = new URL(continuation.href, origin);
  } catch {
    return null;
  }
  if (
    safeContinuation.origin !== origin ||
    safeContinuation.username ||
    safeContinuation.password ||
    safeContinuation.hash ||
    !continuationPaths.has(safeContinuation.pathname)
  )
    return null;

  let parsedViewer: SignInPageViewer;
  if (record(viewer) && viewer.kind === 'signed-out' && keys(viewer) === 'kind') {
    parsedViewer = { kind: 'signed-out' };
  } else if (
    record(viewer) &&
    viewer.kind === 'signed-in' &&
    keys(viewer) === 'account_id,email,kind' &&
    typeof viewer.account_id === 'string' &&
    viewer.account_id.length > 0 &&
    (viewer.email === null ||
      (typeof viewer.email === 'string' &&
        viewer.email.length <= 254 &&
        encoder.encode(viewer.email).byteLength <= 1016 &&
        emailPattern.test(viewer.email)))
  ) {
    parsedViewer = {
      kind: 'signed-in',
      account_id: viewer.account_id,
      email: viewer.email,
    };
  } else {
    return null;
  }

  return {
    methods: { password: methods.password, passkey: methods.passkey },
    viewer: parsedViewer,
    continuation: {
      href: `${safeContinuation.pathname}${safeContinuation.search}`,
      requires_sign_in: continuation.requires_sign_in,
    },
  };
}

export function canContinueAsCurrentAccount(page: SignInPage): boolean {
  return page.viewer.kind === 'signed-in' && !page.continuation.requires_sign_in;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(',');
}
