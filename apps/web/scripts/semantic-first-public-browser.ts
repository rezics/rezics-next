import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import {
  createSubject,
  readSubject,
  requireStatus,
  subjectHref,
  type KernelCall,
  type WalkStackOrigins,
} from './semantic-first-public-native.ts';
import { mountedSubjectReadHeader, mountedSubjectReads } from '../src/subject/mounted-read-diagnostic.ts';

export type SemanticBrowserReader = 'matched' | 'signed-out' | 'different-reader' | 'unavailable';
export type SemanticPageObservation = {
  requestedUrl: string;
  url?: string;
  status?: number;
  stage: 'navigation' | 'document' | 'hydration' | 'main' | 'reader' | 'capture' | 'complete';
  failure?: 'http-status' | 'auth-redirect' | 'timeout' | 'closed' | 'transport' | 'reader';
  reader?: SemanticBrowserReader;
  clientError?: 'module-load' | 'module-initialization' | 'runtime';
};
export type MountedSubjectDiagnostic = { status: number; native: ReturnType<typeof mountedSubjectReads> };
export type SemanticBrowserSession = {
  stack: WalkStackOrigins;
  call: KernelCall;
  editor: string;
  anonymous: BrowserContext;
  member: BrowserContext;
  evidenceDir: string;
  frontendCause?: string;
  mountedSubject?: MountedSubjectDiagnostic;
  pages?: SemanticPageObservation[];
  observePage?: () => Promise<void>;
  verifyMember?: (page: Page) => Promise<SemanticBrowserReader>;
};

export async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 180_000 });
}

async function openPage(
  context: BrowserContext,
  href: string,
  viewport: { width: number; height: number },
  theme: 'light' | 'dark',
  expectedStatus: number,
  observation: SemanticPageObservation,
  observe: () => Promise<void>,
  onMountedSubject?: (diagnostic: MountedSubjectDiagnostic) => void,
): Promise<{ page: Page; status: number; url: string }> {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme });
  if (onMountedSubject) await page.setExtraHTTPHeaders({ [mountedSubjectReadHeader]: '1' });
  page.on('pageerror', (error) => {
    observation.clientError ??=
      /fetch dynamically imported module|Importing a module script|error loading dynamically imported module/i.test(
        error.message,
      )
        ? 'module-load'
        : /before initialization/i.test(error.message)
          ? 'module-initialization'
          : 'runtime';
  });
  try {
    const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    const status = response?.status() ?? 0;
    observation.status = status;
    const resolved = new URL(page.url());
    const requested = new URL(href);
    const authRedirect =
      (resolved.origin !== requested.origin || resolved.pathname !== requested.pathname) &&
      /^\/(?:auth(?:\/|$)|login(?:\/|$)|authorize(?:\/|$)|consent(?:\/|$)|signin(?:\/|$))/.test(resolved.pathname);
    if (resolved.origin !== requested.origin || authRedirect) {
      resolved.search = '';
      resolved.hash = '';
    }
    observation.url = resolved.href;
    observation.stage = 'document';
    if (onMountedSubject) {
      const header = await response?.headerValue(mountedSubjectReadHeader);
      onMountedSubject({ status, native: mountedSubjectReads(header ?? null) });
    }
    await observe();
    if (status !== expectedStatus) {
      observation.failure = 'http-status';
      throw new Error(`${observation.url} returned HTTP ${status}`);
    }
    if (authRedirect) {
      observation.failure = 'auth-redirect';
      throw new Error(`${href} reached Auth at ${observation.url} with HTTP ${status}`);
    }
    observation.stage = 'hydration';
    await hydrated(page);
    observation.stage = 'main';
    await page.locator('main').waitFor({ state: 'visible', timeout: 120_000 });
    return { page, status, url: page.url() };
  } catch (error) {
    observation.failure ??=
      error instanceof Error && /timeout/i.test(error.name + error.message)
        ? 'timeout'
        : error instanceof Error && /closed/i.test(error.message)
          ? 'closed'
          : 'transport';
    await observe().catch(() => {});
    await page.close().catch(() => {});
    throw error;
  }
}

export async function visit(
  session: SemanticBrowserSession,
  href: string,
  options: {
    width?: number;
    theme?: 'light' | 'dark';
    persona?: 'anonymous' | 'member';
    expectedStatus?: number;
    mountedSubject?: boolean;
  } = {},
) {
  if (session.frontendCause) throw new Error(session.frontendCause);
  const observation: SemanticPageObservation = { requestedUrl: href, stage: 'navigation' };
  (session.pages ??= []).push(observation);
  const observe = async () => {
    await session.observePage?.();
  };
  const context = options.persona === 'member' ? session.member : session.anonymous;
  const opened = await openPage(
    context,
    href,
    { width: options.width ?? 1280, height: 900 },
    options.theme ?? 'light',
    options.expectedStatus ?? 200,
    observation,
    observe,
    options.mountedSubject ? (diagnostic) => (session.mountedSubject = diagnostic) : undefined,
  );
  try {
    if (options.persona === 'member' && session.verifyMember) {
      observation.stage = 'reader';
      observation.reader = await session.verifyMember(opened.page);
      if (observation.reader !== 'matched') {
        observation.failure = 'reader';
        throw new Error(`Auth browser reader is ${observation.reader}; expected the current native editor`);
      }
    }
    observation.stage = 'capture';
    const title = await opened.page.title();
    const heading = await opened.page
      .locator('h1, h2')
      .first()
      .textContent()
      .catch(() => null);
    const screenshot = join(
      session.evidenceDir,
      'screenshots',
      `${randomUUID()}-${options.width ?? 1280}-${options.theme ?? 'light'}.png`,
    );
    await opened.page.screenshot({ path: screenshot, fullPage: true });
    observation.stage = 'complete';
    await observe();
    return { url: opened.url, status: opened.status, title, heading, screenshot };
  } catch (error) {
    await observe().catch(() => {});
    throw error;
  } finally {
    await opened.page.close().catch(() => {});
  }
}

export async function createAndRead(
  session: SemanticBrowserSession,
  type: string,
  label: string,
  pagePath: string,
  mountedSubject = false,
) {
  const created = await createSubject(session.call, session.editor, type, label);
  const publicRead = await readSubject(session.call, created.id);
  requireStatus(publicRead, 200, `anonymous ${type}`);
  if ((publicRead.body.subject as { type: string }).type !== type) throw new Error(`${type} public type mismatch`);
  const browser = await visit(session, `${session.stack.web}${pagePath}`, {
    width: type.endsWith('Recipe') || type.includes('Q95074') ? 390 : 1280,
    theme: type.includes('VideoGame') ? 'dark' : 'light',
    persona: 'member',
  });
  const reader = await visit(session, `${session.stack.web}${subjectHref(created.id, label)}`, {
    width: 1440,
    mountedSubject,
  });
  return { native: { id: created.id, type, public: publicRead.status }, browser: { create: browser, reader } };
}
