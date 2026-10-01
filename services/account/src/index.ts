import { Pool } from 'pg';
import { createAccountAuth } from './auth.ts';
import { createAccountApp } from './app.ts';
import { accountConfig } from './config.ts';
import { accountEmailQueue, smtpSender } from './email.ts';
import { bootstrapOperators } from './operators.ts';
import { reconcileResourceScopes } from './resource-scopes.ts';
import { AccessAdmissionRegistry } from '../../main/src/modules/access/admission.ts';
import { mirrorAccountDeletionIntent } from '../../main/src/modules/outbox/account-deletion-journal.ts';
import { retainAccountSubjectDeletion } from '../../main/src/modules/outbox/account-subject-deletion.ts';

const config = accountConfig();
const { ACCOUNT_BASE_URL: baseURL, ACCOUNT_SECRET: secret, ACCOUNT_MAIN_RESOURCE: resource,
  ACCOUNT_DATABASE_URL: databaseURL, ACCOUNT_PORT: port } = config;

// A remote or partitioned database fails a connection wait after five seconds
// instead of holding the request; the caller sees Account as unavailable.
const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5_000 });
const accessDatabaseURL = config.ACCOUNT_ACCESS_DATABASE_URL;
const relayDatabaseURL = config.ACCOUNT_RELAY_DATABASE_URL;
const accessPool = accessDatabaseURL ? new Pool({ connectionString: accessDatabaseURL }) : null;
const relayPool = relayDatabaseURL ? new Pool({ connectionString: relayDatabaseURL }) : null;
const access = accessPool ? new AccessAdmissionRegistry(accessPool, config.FUSEKI_TITLE_ADMISSION_KEY) : null;
const operatorUserIds = new Set(config.ACCOUNT_OPERATOR_USER_IDS.split(',').map(s => s.trim()).filter(Boolean));
await bootstrapOperators(pool, operatorUserIds);
if (await reconcileResourceScopes(pool, resource)) console.info('Account: Main resource scopes updated to the installed set');
const email = accountEmailQueue(pool, secret, smtpSender({ host: config.ACCOUNT_SMTP_HOST,
  port: config.ACCOUNT_SMTP_PORT, secure: config.ACCOUNT_SMTP_SECURE,
  requireTLS: config.ACCOUNT_SMTP_REQUIRE_TLS, user: config.ACCOUNT_SMTP_USER,
  password: config.ACCOUNT_SMTP_PASSWORD, from: config.ACCOUNT_EMAIL_FROM }), baseURL);
let delivering = false;
const deliveryTimer = setInterval(() => {
  if (delivering) return;
  delivering = true;
  void email.drain().catch(() => console.error('Account email queue unavailable'))
    .finally(() => { delivering = false; });
}, 1_000);
createAccountApp(createAccountAuth({ baseURL, secret, resource, pool, operatorUserIds, email, requireEmailVerification: true,
  turnstileSecretKey: config.ACCOUNT_TURNSTILE_SECRET_KEY,
  turnstileMode: config.ACCOUNT_TURNSTILE_MODE as 'local' | 'cloudflare',
  accessDeletionFence: access ? async subject => {
    const issuer = new URL('/api/auth', baseURL).toString();
    const fence = await access.strongDeactivateAccountSubject(issuer, subject);
    if (fence) {
      await mirrorAccountDeletionIntent(accessPool!, relayPool!, fence.principalId, fence.enforcementEpoch);
    }
    await retainAccountSubjectDeletion(relayPool!, issuer, subject);
  } : undefined,
}), pool, { operatorUserIds, displayPreferenceClientIds: new Set([config.WEB_OAUTH_CLIENT_ID].filter(Boolean)),
  trustedProxyPeers: new Set(config.ACCOUNT_TRUSTED_PROXY_PEERS.split(',').map(value => value.trim()).filter(Boolean)),
  mailEventsSecret: config.ACCOUNT_MAIL_EVENTS_SECRET,
  notificationDigest: { accountSecret: secret, mainSecret: config.ACCOUNT_MAIN_CLIENT_SECRET } })
  .cleanup(() => { clearInterval(deliveryTimer); })
  .listen({ hostname: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', port });
