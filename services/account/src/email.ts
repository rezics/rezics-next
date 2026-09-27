import { randomUUID } from 'node:crypto';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import nodemailer from 'nodemailer';
import type { Pool, PoolClient } from 'pg';

export type AccountLocale = 'en' | 'zh-CN';
export type EmailPurpose = 'verify' | 'reset' | 'change-email' | 'notice';
export interface AccountEmail {
  /** `message`: an operator's words to the user, sent only with `notice`. */
  enqueue(input: { userId: string; to: string; url: string; purpose: EmailPurpose;
    locale: AccountLocale; message?: string }): Promise<void>;
}

export async function enqueueAccountEmail(db: Pool | PoolClient, secret: string, input: Parameters<AccountEmail['enqueue']>[0]) {
  const payload = await symmetricEncrypt({ key: secret, data: JSON.stringify(input) });
  await db.query(`INSERT INTO rezics_account_email (id, user_id, payload, expires_at)
    VALUES ($1, $2, $3, now() + interval '30 minutes')`, [randomUUID(), input.userId, payload]);
}

export function accountLocale(request?: Request): AccountLocale {
  return /^zh(?:-cn|-hans)?(?:[,;\s-]|$)/i.test(request?.headers.get('accept-language') ?? '')
    ? 'zh-CN' : 'en';
}

const copy = {
  en: {
    verify: ['Verify your email address', 'Confirm this email address for your REZICS account.', 'Verify email'],
    reset: ['Reset your password', 'Choose a new password for your REZICS account. This link expires in 30 minutes.', 'Reset password'],
    'change-email': ['Confirm your email change', 'Confirm the request to change your REZICS email address. You will then need to verify the new address.', 'Confirm email change'],
    notice: ['A message about your REZICS account', 'The REZICS team sent you this message about your account:', 'Open your REZICS account'],
    ignore: 'If you did not request this, you can ignore this email.',
  },
  'zh-CN': {
    verify: ['验证邮箱地址', '请确认此邮箱地址用于你的 REZICS 账号。', '验证邮箱'],
    reset: ['重置密码', '为你的 REZICS 账号设置新密码。此链接将在 30 分钟后失效。', '重置密码'],
    'change-email': ['确认更换邮箱', '请确认更换 REZICS 邮箱的请求。之后还需要验证新邮箱。', '确认更换邮箱'],
    notice: ['关于你的 REZICS 账号的消息', 'REZICS 团队就你的账号给你发送了以下消息：', '打开你的 REZICS 账号'],
    ignore: '如果你没有发起此请求，请忽略这封邮件。',
  },
} as const;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;' })[char]!);
}

export function renderAccountEmail(purpose: EmailPurpose, locale: AccountLocale, url: string, notice?: string) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid Account email URL');
  const [subject, message, action] = copy[locale][purpose];
  if (purpose === 'notice') {
    if (!notice?.trim()) throw new Error('A notice needs its message');
    // An operator's message is quoted as plain text; the link is always the account.
    return { subject, text: `${message}\n\n${notice}\n\n${action}: ${url}`,
      html: `<!doctype html><html lang="${locale}"><body><h1>${subject}</h1><p>${message}</p><blockquote style="white-space:pre-wrap">${escapeHtml(notice)}</blockquote><p><a href="${escapeHtml(url)}">${action}</a></p></body></html>` };
  }
  const ignore = copy[locale].ignore;
  return { subject, text: `${message}\n\n${action}: ${url}\n\n${ignore}`,
    html: `<!doctype html><html lang="${locale}"><body><h1>${subject}</h1><p>${message}</p><p><a href="${escapeHtml(url)}">${action}</a></p><p>${ignore}</p></body></html>` };
}

export function smtpSender(config: { host: string; port: number; secure: boolean;
  requireTLS: boolean; user: string; password: string; from: string }) {
  const transport = nodemailer.createTransport({ host: config.host, port: config.port,
    secure: config.secure, requireTLS: config.requireTLS,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 10_000,
    disableFileAccess: true, disableUrlAccess: true });
  return async (mail: { id: string; to: string; subject: string; text: string; html: string }) => {
    const result = await transport.sendMail({ ...mail, from: config.from,
      messageId: `<${mail.id}@${config.from.split('@').at(-1)?.replace(/[<>]/g, '')}>` });
    if (!result.accepted.length) throw new Error('SMTP recipient rejected');
  };
}

/** SMTP is at-least-once at best. A crash after DATA is ambiguous, so stale
 * sending rows become uncertain and are not automatically sent again. Links
 * are short-lived and encrypted at rest; no SMTP call runs in an auth request. */
export function accountEmailQueue(pool: Pool, secret: string, send: ReturnType<typeof smtpSender>) {
  return {
    async enqueue(input: Parameters<AccountEmail['enqueue']>[0]) {
      await enqueueAccountEmail(pool, secret, input);
    },
    async drain(limit = 20) {
      await pool.query(`UPDATE rezics_account_email SET state = 'uncertain', payload = NULL
        WHERE state = 'sending' AND started_at < now() - interval '2 minutes'`);
      await pool.query(`UPDATE rezics_account_email SET state = 'expired', payload = NULL
        WHERE state = 'queued' AND expires_at <= now()`);
      for (let index = 0; index < Math.min(limit, 100); index++) {
        const claimed = await pool.query<{ id: string; user_id: string; payload: string }>(`
          UPDATE rezics_account_email SET state = 'sending', started_at = now()
          WHERE id = (SELECT id FROM rezics_account_email WHERE state = 'queued'
            AND expires_at > now() AND available_at <= now() ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING id, user_id, payload`);
        const row = claimed.rows[0];
        if (!row) break;
        try {
          const input = JSON.parse(await symmetricDecrypt({ key: secret, data: row.payload })) as
            Parameters<AccountEmail['enqueue']>[0];
          // A changed or deleted account must not receive an old reset link.
          // Verification of a new address legitimately targets a different email.
          const user = await pool.query<{ email: string }>('SELECT email FROM "user" WHERE id = $1', [row.user_id]);
          if (!user.rowCount) {
            await pool.query(`UPDATE rezics_account_email SET state = 'queued', started_at = NULL,
              available_at = now() + interval '10 seconds' WHERE id = $1`, [row.id]);
            continue;
          }
          if (input.purpose !== 'verify' && user.rows[0]!.email !== input.to) {
            await pool.query(`UPDATE rezics_account_email SET state = 'expired', payload = NULL WHERE id = $1`, [row.id]);
            continue;
          }
          await send({ id: row.id, to: input.to, ...renderAccountEmail(input.purpose, input.locale, input.url, input.message) });
          await pool.query(`UPDATE rezics_account_email SET state = 'sent', payload = NULL WHERE id = $1`, [row.id]);
        } catch {
          // Do not log a transport exception: it can contain recipient or link data.
          await pool.query(`UPDATE rezics_account_email SET state = 'uncertain', payload = NULL WHERE id = $1`, [row.id]);
        }
      }
    },
  };
}
