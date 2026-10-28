import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { createFakeAuthState, startFakeAuth, type FakeAuthRequest } from '../scripts/fake-auth';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const session = 'account-operation-session';
const calls: FakeAuthRequest[] = [];
const state = createFakeAuthState();
const fake = startFakeAuth({ state, onRequest: (request) => calls.push(request) });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;
let issuerOrigin = '';
let serverOutput = '';

function site(privacyContact: string | null = 'mailto:privacy@example.test'): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    serverOutput = '';
    const keep = (chunk: Buffer) => {
      serverOutput = (serverOutput + chunk.toString()).slice(-8000);
    };
    const env = { ...process.env, AUTH_ORIGIN: fake.url.origin };
    delete env.PRIVACY_CONTACT_URL;
    if (privacyContact !== null) env.PRIVACY_CONTACT_URL = privacyContact;
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let startError: Error | undefined;
    child.on('error', (error) => (startError = error));
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    issuerOrigin = origin;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${serverOutput}`);
      try {
        const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(60_000) });
        if (response.status === 200) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /login in time:\n${serverOutput}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function stopSite() {
  if (child?.pid && child.exitCode === null) {
    const stopped = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    process.kill(-child.pid, 'SIGTERM');
    await stopped;
  }
  child = undefined;
  started = undefined;
}

async function open(
  path: string,
  options: BrowserContextOptions = {},
  withSessionCookie = true,
): Promise<{ page: Page; origin: string }> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    locale: 'en',
    ...options,
    javaScriptEnabled: true,
  });
  if (withSessionCookie)
    await context.addCookies([
      { name: 'auth_session', value: session, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    expect(response?.status(), `the documented dev server serves ${path}`).toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, origin };
  } catch (error) {
    await context.close();
    throw error;
  }
}

const copy = {
  en: {
    erased: 'Erased',
    erasedItems: [
      'Your profile, name, handle and avatar.',
      'Your whole library: shelf entries, reading progress and history, copies and follows.',
      'Your private, unlisted and deleted Collections.',
      'Reading logs you explicitly published.',
    ],
    retained: 'Stays, without your name',
    retainedItems: ['Your public Collections as they are now, with their current notes.', 'Your posts and reviews.'],
    attribution:
      'These contributions remain attributed to “Deleted account”, frozen and no longer editable by anyone. No replacement curator is assigned.',
    prepare: 'If you do not want something to stay, make the Collection private or delete the post first.',
    privacy: 'To get a copy of your data, before or after deletion, contact mailto:privacy@example.test.',
  },
  de: {
    erased: 'Wird gelöscht',
    erasedItems: [
      'Dein Profil, Name, Handle und Avatar.',
      'Deine gesamte Bibliothek: Regaleinträge, Lesefortschritt und Leseverlauf, Exemplare und gefolgte Inhalte.',
      'Deine privaten, nicht gelisteten und gelöschten Sammlungen.',
      'Leseprotokolle, die du ausdrücklich veröffentlicht hast.',
    ],
    retained: 'Bleibt ohne deinen Namen erhalten',
    retainedItems: [
      'Deine öffentlichen Sammlungen im jetzigen Zustand mit ihren aktuellen Notizen.',
      'Deine Beiträge und Rezensionen.',
    ],
    attribution:
      'Diese Inhalte bleiben unter „Gelöschtes Konto“ erhalten, werden eingefroren und können von niemandem mehr bearbeitet werden. Es wird keine neue Betreuung zugewiesen.',
    prepare: 'Wenn etwas nicht erhalten bleiben soll, stelle die Sammlung vorher auf privat oder lösche den Beitrag.',
    privacy: 'Für eine Kopie deiner Daten, vor oder nach der Löschung, wende dich an mailto:privacy@example.test.',
  },
  es: {
    erased: 'Se elimina',
    erasedItems: [
      'Tu perfil, nombre, identificador y avatar.',
      'Toda tu biblioteca: entradas de estantería, progreso e historial de lectura, ejemplares y seguimientos.',
      'Tus colecciones privadas, no listadas y eliminadas.',
      'Los registros de lectura que publicaste expresamente.',
    ],
    retained: 'Se conserva, sin tu nombre',
    retainedItems: [
      'Tus colecciones públicas tal como están ahora, con sus notas actuales.',
      'Tus publicaciones y reseñas.',
    ],
    attribution:
      'Estas contribuciones se conservan a nombre de «Cuenta eliminada», quedan congeladas y nadie podrá editarlas. No se asignará otra persona para gestionarlas.',
    prepare: 'Si no quieres que algo se conserve, haz privada la colección o elimina la publicación primero.',
    privacy:
      'Para obtener una copia de tus datos, antes o después de eliminar la cuenta, contacta con mailto:privacy@example.test.',
  },
  fr: {
    erased: 'Ce qui est effacé',
    erasedItems: [
      'Votre profil, votre nom, votre identifiant et votre avatar.',
      'Toute votre bibliothèque : entrées sur les étagères, progression et historique de lecture, exemplaires et suivis.',
      'Vos collections privées, non répertoriées et supprimées.',
      'Les journaux de lecture que vous avez expressément publiés.',
    ],
    retained: 'Ce qui reste, sans votre nom',
    retainedItems: [
      'Vos collections publiques dans leur état actuel, avec leurs notes actuelles.',
      'Vos publications et vos critiques.',
    ],
    attribution:
      'Ces contributions restent attribuées à « Compte supprimé », sont figées et ne peuvent plus être modifiées par personne. Aucun autre responsable ne sera désigné.',
    prepare:
      'Si vous ne voulez pas conserver un contenu, rendez la collection privée ou supprimez la publication au préalable.',
    privacy:
      'Pour obtenir une copie de vos données, avant ou après la suppression, contactez mailto:privacy@example.test.',
  },
  ja: {
    erased: '削除されるもの',
    erasedItems: [
      'プロフィール、名前、ハンドル、アバター。',
      'ライブラリ全体：本棚の登録、読書の進捗と履歴、所蔵本、フォロー。',
      '非公開、限定公開、削除済みのコレクション。',
      '自分の意思で公開した読書記録。',
    ],
    retained: '名前を伏せて残るもの',
    retainedItems: ['公開コレクションとその現在のメモ。今の状態のまま残ります。', '投稿とレビュー。'],
    attribution:
      'これらは「削除されたアカウント」によるものとして凍結され、誰も編集できなくなります。代わりの管理者は割り当てられません。',
    prepare: '残したくないものがある場合は、先にコレクションを非公開にするか、投稿を削除してください。',
    privacy:
      '削除の前後を問わず、データのコピーをご希望の場合は、プライバシー窓口 mailto:privacy@example.test にご連絡ください。',
  },
  ko: {
    erased: '삭제되는 항목',
    erasedItems: [
      '프로필, 이름, 핸들, 아바타.',
      '서재 전체: 책장 항목, 독서 진행 상황과 기록, 소장본, 팔로우.',
      '비공개, 미등록, 삭제된 컬렉션.',
      '직접 공개한 독서 일지.',
    ],
    retained: '이름 없이 남는 항목',
    retainedItems: ['현재 메모를 포함한 공개 컬렉션이 지금 상태 그대로 남습니다.', '게시물과 리뷰.'],
    attribution:
      '이 기여는 “삭제된 계정”의 것으로 표시되며 동결되어 누구도 수정할 수 없습니다. 대신 관리할 사람은 지정되지 않습니다.',
    prepare: '남기고 싶지 않은 항목이 있다면 먼저 컬렉션을 비공개로 바꾸거나 게시물을 삭제하세요.',
    privacy: '삭제 전이나 후에 데이터 사본을 받으려면 개인정보 문의처 mailto:privacy@example.test 로 연락하세요.',
  },
  'zh-Hans': {
    erased: '将被清除',
    erasedItems: [
      '你的个人资料、姓名、账号标识和头像。',
      '你的整个书库：书架条目、阅读进度和历史、藏本以及关注。',
      '你的私人、不公开列出和已删除的收藏集。',
      '你主动发布的阅读日志。',
    ],
    retained: '保留，但不再显示你的姓名',
    retainedItems: ['你的公开收藏集及其当前笔记，按现状保留。', '你的帖子和书评。'],
    attribution: '这些贡献将显示为由“已删除的账号”发布，并被冻结，任何人都无法再编辑。不会指定接替的管理者。',
    prepare: '如果不希望某项内容被保留，请先将收藏集设为私人或删除帖子。',
    privacy: '无论删除账户之前还是之后，如需获取你的数据副本，请联系隐私事务联系人：mailto:privacy@example.test。',
  },
  'zh-Hant': {
    erased: '將被清除',
    erasedItems: [
      '你的個人資料、姓名、帳號識別名稱和頭像。',
      '你的整個書庫：書架項目、閱讀進度與歷史、藏本以及追蹤。',
      '你的私人、不公開列出和已刪除的收藏集。',
      '你主動發布的閱讀日誌。',
    ],
    retained: '保留，但不再顯示你的姓名',
    retainedItems: ['你的公開收藏集及其目前筆記，按現狀保留。', '你的貼文和書評。'],
    attribution: '這些貢獻將顯示為由「已刪除的帳號」發布，並遭凍結，任何人都無法再編輯。不會指定接替的管理者。',
    prepare: '如果不希望某項內容被保留，請先將收藏集設為私人或刪除貼文。',
    privacy: '無論刪除帳戶之前還是之後，如需取得你的資料副本，請聯絡隱私事務聯絡人：mailto:privacy@example.test。',
  },
};

beforeAll(async () => {
  await site();
  browser = await chromium.launch();
}, timeout);

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  await stopSite();
});

for (const [locale, expected] of Object.entries(copy)) {
  test(
    `${locale}: deletion lists erased data, retained contributions and attribution, preparation, and the privacy contact`,
    async () => {
      const { page } = await open('/account/delete', {
        locale,
        extraHTTPHeaders: { 'Accept-Language': locale },
      });
      try {
        await page.getByRole('textbox').waitFor({ state: 'visible' });
        expect(await page.locator('html').getAttribute('lang')).toBe(locale);
        for (const [heading, items] of [
          [expected.erased, expected.erasedItems],
          [expected.retained, expected.retainedItems],
        ] as const) {
          const section = page.getByRole('region', { name: heading, exact: true });
          expect(await section.getByRole('heading', { name: heading, level: 2, exact: true }).isVisible()).toBe(true);
          expect(await section.getByRole('listitem').allTextContents()).toEqual(items);
        }
        expect(await page.getByText(expected.attribution, { exact: true }).isVisible()).toBe(true);
        expect(await page.getByText(expected.prepare, { exact: true }).isVisible()).toBe(true);
        expect(await page.getByText(expected.privacy, { exact: true }).isVisible()).toBe(true);
        const contact = page.getByRole('link', { name: 'mailto:privacy@example.test', exact: true });
        expect(await contact.isVisible()).toBe(true);
        expect(await contact.getAttribute('href')).toBe('mailto:privacy@example.test');
        expect(await page.locator('main').innerText()).not.toMatch(
          /\b(immediately|instantly|within \d+|by \d{4}|sofort|unverzüglich|inmediatamente|immédiatement)\b|即時|立即|马上|馬上|すぐに|直ちに|즉시/iu,
        );
        expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
      } finally {
        await page.context().close();
      }
    },
    timeout,
  );
}

test('configuration loads without validating PRIVACY_CONTACT_URL so dev, route generation, typecheck and build can start', async () => {
  for (const value of [
    undefined,
    '',
    '   ',
    'privacy@example.test',
    '/privacy',
    'http://example.test/privacy',
    'javascript:alert(1)',
    'https://',
    'mailto:',
  ]) {
    const env = { ...process.env };
    delete env.PRIVACY_CONTACT_URL;
    if (value !== undefined) env.PRIVACY_CONTACT_URL = value;
    const child = Bun.spawn(['bun', '-e', "await import('./cloudflare.config.ts')"], {
      cwd: app,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, `configuration must load with ${JSON.stringify(value)}:\n${stderr}`).toBe(0);
  }
  for (const value of ['mailto:privacy@example.test', 'https://example.test/privacy']) {
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        "const { default: config } = await import('./cloudflare.config.ts'); console.log(config.worker.env.PRIVACY_CONTACT_URL.value)",
      ],
      {
        cwd: app,
        env: { ...process.env, PRIVACY_CONTACT_URL: value },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe(value);
  }
});

test(
  'a configured https privacy contact is named and linked on the deletion page',
  async () => {
    await stopSite();
    await site('https://example.test/privacy');
    const { page } = await open('/account/delete');
    try {
      await page.getByRole('textbox').waitFor({ state: 'visible' });
      const link = page.getByRole('link', { name: 'https://example.test/privacy', exact: true });
      expect(await link.isVisible()).toBe(true);
      expect(await link.getAttribute('href')).toBe('https://example.test/privacy');
      expect(
        await page
          .getByText('To get a copy of your data, before or after deletion, contact https://example.test/privacy.', {
            exact: true,
          })
          .isVisible(),
      ).toBe(true);
      await page.getByRole('textbox').fill('delete my account');
      expect(await page.getByRole('button', { name: 'Delete account', exact: true }).isEnabled()).toBe(true);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

for (const contact of [null, 'http://example.test/privacy', 'mailto:', 'mailto:not-an-address']) {
  test(
    `without a valid privacy contact (${JSON.stringify(contact)}), deletion fails closed at request time`,
    async () => {
      await stopSite();
      await site(contact);
      const { page } = await open('/account/delete');
      try {
        await page.getByRole('textbox').waitFor({ state: 'visible' });
        for (const [heading, items] of [
          [copy.en.erased, copy.en.erasedItems],
          [copy.en.retained, copy.en.retainedItems],
        ] as const) {
          expect(
            await page.getByRole('region', { name: heading, exact: true }).getByRole('listitem').allTextContents(),
          ).toEqual(items);
        }
        expect(
          await page
            .getByRole('alert')
            .getByText('Account deletion is unavailable right now.', { exact: true })
            .isVisible(),
        ).toBe(true);
        expect(await page.getByRole('link', { name: /privacy/ }).count()).toBe(0);
        await page.getByRole('textbox').fill('delete my account');
        expect(await page.getByRole('button', { name: 'Delete account', exact: true }).isDisabled()).toBe(true);
        const writesBefore = calls.filter((call) => call.method !== 'GET').length;
        await page.locator('form').evaluate((form) => (form as HTMLFormElement).requestSubmit());
        await page.waitForTimeout(300);
        expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(writesBefore);
        expect(serverOutput).toContain('PRIVACY_CONTACT_URL');
      } finally {
        await page.context().close();
      }
    },
    timeout,
  );
}
