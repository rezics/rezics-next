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
  redirected: boolean;
  wireStatus?: number;
  wireMime?: string;
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

    session.on(
      'Network.requestWillBeSent',
      ({ requestId, frameId, loaderId, type, request, initiator, redirectResponse }) => {
        if (frameId !== frameTree.frame.id) return;
        if (type === 'Document') {
          if (loader && loader !== loaderId) followingDocuments++;
          else if (request.url === target.href) loader = loaderId;
          return;
        }
        if (loaderId !== loader || type !== 'Script') return;
        if (redirectResponse) {
          const script = requests.get(requestId);
          if (script && !failures.has('redirect')) {
            script.wireStatus = redirectResponse.status;
            failures.set('redirect', { script, reason: 'redirect', observedMs: now() });
          }
        }
        requests.set(requestId, {
          url: request.url,
          importer: initiator.url ?? initiator.stack?.callFrames[0]?.url,
          redirected: Boolean(redirectResponse),
        });
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
      script.mime = moduleContentType(response.mimeType);
      const reason = response.status >= 400 ? `http-${response.status}` : script.mime;
      if (reason !== 'javascript' && !failures.has(reason) && failures.size < 12)
        failures.set(reason, { script, reason, observedMs: now() });
    });
    session.on('Network.loadingFailed', ({ requestId, errorText, canceled, blockedReason, corsErrorStatus }) => {
      const script = requests.get(requestId);
      if (!script) return;
      const reason = /^net::ERR_[A-Z0-9_]{1,40}$/u.test(errorText) ? errorText : 'request-failed';
      const cors = corsErrorStatus?.corsError;
      const key = [reason, canceled, blockedReason, cors].join('/');
      // Keep one example per outcome and release unrelated failures even during a cancellation burst.
      if (!failures.has(key) && failures.size < 12)
        failures.set(key, { script, reason, canceled, blocked: blockedReason, cors, observedMs: now() });
      else requests.delete(requestId);
    });
    session.on('Network.loadingFinished', ({ requestId }) => requests.delete(requestId));
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
          return { module: label(url), source: webSource(url, target.origin) };
        };
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
          failures: [...failures.values()].map(({ script, ...failure }) => {
            const transfer = transfers.get(script.url);
            return {
              ...failure,
              ...describe(script.url),
              importer: script.importer && URL.canParse(script.importer) ? describe(script.importer) : undefined,
              wireStatus: script.wireStatus,
              wireMime: script.wireMime,
              mime: script.mime,
              bridgeForUrl: transfer && transfer.attempts > 1 ? { attempts: transfer.attempts } : (transfer ?? null),
            };
          }),
        };
      },
      close: () => session.detach(),
    };
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}

export type WebDocumentModules = Awaited<ReturnType<typeof observeWebDocumentModules>>;
