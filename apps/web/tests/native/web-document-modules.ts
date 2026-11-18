import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';

export function moduleContentType(value: string | null | undefined): string {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mime) return 'absent';
  if (/^(?:application|text)\/(?:javascript|ecmascript)$/u.test(mime)) return 'javascript';
  return mime === 'text/html' ? 'html' : 'other';
}

const sourceRoot = resolve(import.meta.dir, '../../src');
const compiledEntry = /^\/assets\/index-[\w-]+\.js$/u;

function assetDigest(url: URL, origin: string): string | undefined {
  if (url.origin !== origin || !/^\/assets\/[\w.$-]+\.js$/u.test(url.pathname)) return;
  return createHash('sha256').update(url.pathname).digest('hex').slice(0, 16);
}

// Only report paths that name Web source in this checkout. Dependency paths, URL queries and
// unknown paths may contain host or account data and keep the caller's fixed module label.
function webSource(url: URL, origin: string): string | undefined {
  if (url.origin !== origin) return;
  const pathname = url.pathname.replace(`/@fs${sourceRoot}/`, '/src/');
  if (!/^\/src\/(?:[\w$-]+\/)*[\w.$-]+\.(?:[cm]?js|jsx|ts|tsx)$/u.test(pathname)) return;
  if (existsSync(resolve(sourceRoot, pathname.slice(5)))) return pathname;
}

export type WebModuleTransfer = {
  attempts: number;
  conditional: boolean;
  status?: number;
  mime?: string;
  bytes?: number;
  htmlBody?: boolean;
  startedMs: number;
  socketWrite?: 'finished' | 'failed';
  socketSettledMs?: number;
  error?: string;
};

type Script = {
  url: string;
  importer: string | undefined;
  initiator: string;
  redirected: boolean;
  wireStatus?: number;
  wireMime?: string;
  status?: number;
  mime?: string;
};
type Failure = {
  script: Script;
  observedMs: number;
  reason: string;
  canceled?: boolean | undefined;
  blocked?: string | undefined;
  cors?: string | undefined;
};

/** The HTTP bridge and Chromium run in different namespaces. Match their observations by the entire
 * module URL within one navigation window. Only the browser can attribute a request to a document loader. */
export async function observeWebDocumentModules(page: Page, target: URL, label: (url: URL) => string) {
  const session = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const requests = new Map<string, Script>();
    const transfers = new Map<string, WebModuleTransfer>();
    const failures = new Map<string, Failure>();
    const now = () => Math.round(performance.now());
    let loader: string | undefined;
    let followingDocuments = 0;
    let overflow = false;
    let entry: { script: Script; delivery: 'pending' | 'finished' | 'failed' | 'redirected' } | undefined;

    session.on(
      'Network.requestWillBeSent',
      ({ requestId, frameId, loaderId, type, request, initiator, redirectResponse }) => {
        if (frameId !== frameTree.frame.id) return;
        if (type === 'Document') {
          if (loader && loader !== loaderId) followingDocuments++;
          else if (request.url === target.href) loader = loaderId;
          return;
        }
        if (!loader || loaderId !== loader || type !== 'Script') return;
        if (redirectResponse) {
          const script = requests.get(requestId);
          if (script) {
            if (entry?.script === script) entry.delivery = 'redirected';
            script.wireStatus = redirectResponse.status;
            if (!failures.has('redirect') && failures.size < 12)
              failures.set('redirect', { script, reason: 'redirect', observedMs: now() });
          }
        }
        const script = {
          url: request.url,
          importer: initiator.url ?? initiator.stack?.callFrames[0]?.url,
          initiator: initiator.type,
          redirected: Boolean(redirectResponse),
        };
        requests.set(requestId, script);
        const url = new URL(script.url);
        if (!entry && url.origin === target.origin && compiledEntry.test(url.pathname))
          entry = { script, delivery: 'pending' };
      },
    );
    session.on('Network.responseReceivedExtraInfo', ({ requestId, statusCode, headers }) => {
      const script = requests.get(requestId);
      // Redirect hops reuse the protocol request ID, and ExtraInfo can arrive after the next hop starts.
      if (!script || script.redirected) return;
      script.wireStatus = statusCode;
      script.wireMime = moduleContentType(headers['content-type'] ?? headers['Content-Type']);
    });
    session.on('Network.responseReceived', ({ requestId, response }) => {
      const script = requests.get(requestId);
      if (!script) return;
      script.status = response.status;
      script.mime = moduleContentType(response.mimeType);
      const reason = response.status >= 400 ? `http-${response.status}` : script.mime;
      if (reason !== 'javascript' && !failures.has(reason) && failures.size < 12)
        failures.set(reason, { script, reason, observedMs: now() });
    });
    session.on('Network.loadingFailed', ({ requestId, errorText, canceled, blockedReason, corsErrorStatus }) => {
      const script = requests.get(requestId);
      if (!script) return;
      requests.delete(requestId);
      if (entry?.script === script) entry.delivery = 'failed';
      const reason = /^net::ERR_[A-Z0-9_]{1,40}$/u.test(errorText) ? errorText : 'request-failed';
      const cors = corsErrorStatus?.corsError;
      const key = [reason, canceled, blockedReason, cors, script.url].join('/');
      if (!failures.has(key) && failures.size < 12)
        failures.set(key, { script, reason, canceled, blocked: blockedReason, cors, observedMs: now() });
    });
    session.on('Network.loadingFinished', ({ requestId }) => {
      if (entry && entry.script === requests.get(requestId)) entry.delivery = 'finished';
      requests.delete(requestId);
    });
    await session.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });

    return {
      upstream(url: string, conditional: boolean): WebModuleTransfer | undefined {
        if (!loader) return;
        const previous = transfers.get(url);
        if (previous) {
          previous.attempts++;
          return;
        }
        if (transfers.size >= 16_384) {
          overflow = true;
          return;
        }
        const transfer = { attempts: 1, conditional, startedMs: now() };
        transfers.set(url, transfer);
        return transfer;
      },
      snapshot() {
        const describe = (href: string) => {
          const url = new URL(href);
          return {
            module: label(url),
            source: webSource(url, target.origin),
            assetDigest: assetDigest(url, target.origin),
          };
        };
        const describeScript = (script: Script) => ({
          ...describe(script.url),
          initiator: script.initiator,
          importer: script.importer && URL.canParse(script.importer) ? describe(script.importer) : undefined,
          wireStatus: script.wireStatus,
          wireMime: script.wireMime,
          status: script.status,
          mime: script.mime,
        });
        // The loader can reject an import before Chromium emits a response event for its dependency.
        let unexpectedUpstream;
        for (const [href, transfer] of transfers) {
          if (
            transfer.error ||
            (transfer.status !== undefined &&
              transfer.status !== 304 &&
              (transfer.status !== 200 || transfer.mime !== 'javascript' || transfer.htmlBody))
          ) {
            unexpectedUpstream = { ...describe(href), ...transfer };
            break;
          }
        }
        return {
          matchedDocument: loader !== undefined,
          followingDocuments,
          overflow,
          unexpectedUpstream,
          entry: entry && { ...describeScript(entry.script), delivery: entry.delivery },
          pendingCount: requests.size,
          pending: [...requests.values()].slice(0, 6).map(describeScript),
          failures: [...failures.values()].map(({ script, ...failure }) => {
            const transfer = transfers.get(script.url);
            return {
              ...failure,
              ...describeScript(script),
              bridgeForUrl: transfer && transfer.attempts > 1 ? { attempts: transfer.attempts } : (transfer ?? null),
            };
          }),
        };
      },
      bootstrap() {
        return page.evaluate(
          ({ origin, pathname }) => {
            if (location.origin !== origin || location.pathname !== pathname) return null;
            const globals = window as Window & {
              __TSS_START_OPTIONS__?: unknown;
              $_TSR?: { router?: unknown; initialized?: boolean; streamEnded?: boolean; hydrated?: boolean };
            };
            const router = globals.$_TSR;
            const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
            const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content;
            return {
              moduleScript: Boolean(entry),
              entryNonceMatches: Boolean(nonce && entry?.nonce === nonce),
              clientLoadFailed: document.documentElement.hasAttribute('data-client-load-failed'),
              hydrated: document.documentElement.hasAttribute('data-hydrated'),
              startOptions: Boolean(globals.__TSS_START_OPTIONS__),
              routerBootstrap: Boolean(router),
              routerPayload: Boolean(router?.router),
              routerInitialized: router?.initialized === true,
              streamEnded: router?.streamEnded === true,
              routerHydrated: router?.hydrated === true,
            };
          },
          { origin: target.origin, pathname: target.pathname },
        );
      },
      close: () => session.detach(),
    };
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}

export type WebDocumentModules = Awaited<ReturnType<typeof observeWebDocumentModules>>;
