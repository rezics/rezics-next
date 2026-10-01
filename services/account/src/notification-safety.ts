import { createHmac, timingSafeEqual } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import { accountLocales, emailLocale } from './account-settings.ts';
import { enqueueAccountEmail, type AccountLocale } from './email.ts';

const reasons = ['approaching', 'unacknowledged', 'overdue'] as const;
/** Exact queue/principal keys; encryption and SMTP costs remain Account-owned. */
export const SAFETY_MAIL_COST = {
  intakeStatements: 4,
  lookupStatements: 1,
  responseBytes: 1024,
} as const;
type Reason = (typeof reasons)[number];
const copy: Record<
  AccountLocale,
  { heading: string; deadline: string; action: string; reasons: Record<Reason, string> }
> = {
  en: {
    heading: 'Safety response required',
    deadline: 'Deadline (UTC)',
    action: 'Open the platform safety queue and review the case.',
    reasons: {
      approaching: 'A safety deadline is approaching.',
      unacknowledged: 'The primary responder has not acknowledged the alert.',
      overdue: 'A safety deadline has passed.',
    },
  },
  'zh-Hans': {
    heading: '需要处理安全事项',
    deadline: '截止时间（UTC）',
    action: '打开平台安全队列并审核案件。',
    reasons: {
      approaching: '安全事项的截止时间即将到来。',
      unacknowledged: '主要响应人员尚未确认此提醒。',
      overdue: '安全事项已超过截止时间。',
    },
  },
  'zh-Hant': {
    heading: '需要處理安全事項',
    deadline: '截止時間（UTC）',
    action: '開啟平台安全佇列並審核案件。',
    reasons: {
      approaching: '安全事項的截止時間即將到來。',
      unacknowledged: '主要回應人員尚未確認此提醒。',
      overdue: '安全事項已超過截止時間。',
    },
  },
  ja: {
    heading: '安全対応が必要です',
    deadline: '期限（UTC）',
    action: 'プラットフォームの安全対応キューを開き、案件を確認してください。',
    reasons: {
      approaching: '安全対応の期限が近づいています。',
      unacknowledged: '主担当者がこの通知を確認していません。',
      overdue: '安全対応の期限を過ぎています。',
    },
  },
  ko: {
    heading: '안전 대응이 필요합니다',
    deadline: '기한(UTC)',
    action: '플랫폼 안전 대기열을 열어 사례를 검토하세요.',
    reasons: {
      approaching: '안전 대응 기한이 다가오고 있습니다.',
      unacknowledged: '주 담당자가 아직 알림을 확인하지 않았습니다.',
      overdue: '안전 대응 기한이 지났습니다.',
    },
  },
  de: {
    heading: 'Sicherheitsfall erfordert eine Antwort',
    deadline: 'Frist (UTC)',
    action: 'Öffnen Sie die Sicherheitswarteschlange der Plattform und prüfen Sie den Fall.',
    reasons: {
      approaching: 'Eine Sicherheitsfrist nähert sich.',
      unacknowledged: 'Die primär zuständige Person hat den Hinweis nicht bestätigt.',
      overdue: 'Eine Sicherheitsfrist ist abgelaufen.',
    },
  },
  fr: {
    heading: 'Une intervention de sécurité est nécessaire',
    deadline: 'Échéance (UTC)',
    action: 'Ouvrez la file de sécurité de la plateforme et examinez le dossier.',
    reasons: {
      approaching: 'Une échéance de sécurité approche.',
      unacknowledged: 'La personne responsable principale n’a pas accusé réception de l’alerte.',
      overdue: 'Une échéance de sécurité est dépassée.',
    },
  },
  es: {
    heading: 'Se requiere una respuesta de seguridad',
    deadline: 'Fecha límite (UTC)',
    action: 'Abra la cola de seguridad de la plataforma y revise el caso.',
    reasons: {
      approaching: 'Se acerca una fecha límite de seguridad.',
      unacknowledged: 'La persona responsable principal no ha confirmado la alerta.',
      overdue: 'Se ha superado una fecha límite de seguridad.',
    },
  },
};
export function safetyAlertMessage(
  locale: AccountLocale,
  deadline: string,
  reason: Reason,
): string {
  const text = copy[locale];
  return `${text.heading}\n${text.reasons[reason]}\n${text.deadline}: ${deadline}\n\n${text.action}`;
}

function authorized(value: string | null, secret: string): boolean {
  if (!secret || !value?.startsWith('Bearer ')) return false;
  const received = Buffer.from(value.slice(7)),
    expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
function mailId(secret: string, deliveryId: string): string {
  const bytes = createHmac('sha256', secret).update(`safety-alert-mail-v1\0${deliveryId}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
type MailState = {
  state: 'queued' | 'sending' | 'sent' | 'uncertain' | 'expired';
  user_id: string;
};
const id = t.String({ format: 'uuid' });
const status = t.Object({
  state: t.Union(
    ['queued', 'sending', 'sent', 'uncertain', 'expired'].map((value) => t.Literal(value)),
  ),
  messageId: id,
});

/** Fixed-size mandatory notice intake and exact status lookup. Account owns the
 * current verified address, encrypted queue and SMTP outcome. No evidence,
 * reporter contact, case credential or address crosses this internal API. */
export function notificationSafetyApi(
  pool: Pool,
  accountSecret: string,
  mainSecret: string,
  accountBaseUrl: string,
) {
  const read = async (deliveryId: string) => {
    const messageId = mailId(accountSecret, deliveryId);
    const row = (
      await pool.query<MailState>('SELECT state,user_id FROM rezics_account_email WHERE id = $1', [
        messageId,
      ])
    ).rows[0];
    return { messageId, row };
  };
  return new Elysia()
    .post(
      '/api/internal/safety-alerts',
      {
        body: t.Object(
          {
            deliveryId: id,
            userId: t.String({ minLength: 1, maxLength: 128 }),
            deadline: t.String({ format: 'date-time', maxLength: 64 }),
            reason: t.Union(reasons.map((value) => t.Literal(value))),
          },
          { additionalProperties: false },
        ),
        response: {
          200: status,
          403: t.Object({ error: t.String() }),
          409: t.Object({ error: t.String() }),
        },
      },
      async ({ request, body: input }) => {
        if (!authorized(request.headers.get('authorization'), mainSecret))
          return Response.json({ error: 'forbidden' }, { status: 403 });
        const previous = await read(input.deliveryId);
        if (previous.row)
          return previous.row.user_id === input.userId
            ? Response.json({ state: previous.row.state, messageId: previous.messageId })
            : Response.json({ error: 'delivery_conflict' }, { status: 409 });
        const user = (
          await pool.query<{
            email: string;
            emailVerified: boolean;
            locale: string | null;
            signup_locale: string | null;
          }>('SELECT email,"emailVerified",locale,signup_locale FROM "user" WHERE id = $1', [
            input.userId,
          ])
        ).rows[0];
        if (!user?.emailVerified)
          return Response.json({ error: 'verified_address_unavailable' }, { status: 409 });
        const locale =
          emailLocale(user) ??
          (accountLocales.includes(user.signup_locale as AccountLocale)
            ? (user.signup_locale as AccountLocale)
            : null);
        if (!locale) return Response.json({ error: 'language_unavailable' }, { status: 409 });
        // `notice` already bypasses optional-mail suppression. A queue acknowledgement
        // is not SMTP acceptance; Main must look up `sent` before recording delivered.
        await enqueueAccountEmail(
          pool,
          accountSecret,
          {
            userId: input.userId,
            to: user.email,
            purpose: 'notice',
            locale,
            url: accountBaseUrl,
            message: safetyAlertMessage(
              locale,
              new Date(input.deadline).toISOString(),
              input.reason,
            ),
          },
          previous.messageId,
        );
        const current = await read(input.deliveryId);
        if (!current.row || current.row.user_id !== input.userId)
          return Response.json({ error: 'delivery_conflict' }, { status: 409 });
        return Response.json({ state: current.row.state, messageId: current.messageId });
      },
    )
    .get(
      '/api/internal/safety-alerts/:deliveryId',
      {
        params: t.Object({ deliveryId: id }),
        response: {
          200: status,
          403: t.Object({ error: t.String() }),
          404: t.Object({ error: t.String() }),
        },
      },
      async ({ request, params }) => {
        if (!authorized(request.headers.get('authorization'), mainSecret))
          return Response.json({ error: 'forbidden' }, { status: 403 });
        const current = await read(params.deliveryId);
        return current.row
          ? Response.json({ state: current.row.state, messageId: current.messageId })
          : Response.json({ error: 'not_found' }, { status: 404 });
      },
    );
}
