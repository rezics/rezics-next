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
};

export async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 180_000 });
}

async function openPage(
  context: BrowserContext,
  href: string,
  viewport: { width: number; height: number },
  theme: 'light' | 'dark',
  onMountedSubject?: (diagnostic: MountedSubjectDiagnostic) => void,
): Promise<{ page: Page; status: number; url: string }> {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme });
  if (onMountedSubject) await page.setExtraHTTPHeaders({ [mountedSubjectReadHeader]: '1' });
  try {
    const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    const status = response?.status() ?? 0;
    if (onMountedSubject) {
      const header = await response?.headerValue(mountedSubjectReadHeader);
      onMountedSubject({ status, native: mountedSubjectReads(header ?? null) });
    }
    await hydrated(page);
    await page.locator('main').waitFor({ state: 'visible', timeout: 120_000 });
    return { page, status, url: page.url() };
  } catch (error) {
    await page.close();
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
  const context = options.persona === 'member' ? session.member : session.anonymous;
  const opened = await openPage(
    context,
    href,
    { width: options.width ?? 1280, height: 900 },
    options.theme ?? 'light',
    options.mountedSubject ? (diagnostic) => (session.mountedSubject = diagnostic) : undefined,
  );
  if (options.mountedSubject && opened.status !== (options.expectedStatus ?? 200)) {
    await opened.page.close();
    throw new Error(`${href} returned HTTP ${opened.status}`);
  }
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
  await opened.page.close();
  if (opened.status !== (options.expectedStatus ?? 200))
    throw new Error(`${href} returned HTTP ${opened.status}; screenshot ${screenshot}`);
  return { url: opened.url, status: opened.status, title, heading, screenshot };
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
