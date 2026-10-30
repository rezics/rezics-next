import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { BetterAuthOptions } from 'better-auth';
import type { Pool } from 'pg';
import type { AuthServiceOptions } from './index.ts';
import {
  nativeRecoverySource,
  readRecoveryCopySource,
  beginRecoveryCopyDisclosure,
  finishRecoveryCopyDisclosure,
  type RecoveryCopyCode,
} from './recovery-copy-source.ts';

type VerificationHooks = NonNullable<NonNullable<BetterAuthOptions['databaseHooks']>['verification']>;
type Locator = { id: string; accountId: string; proofHash: string; expiresAt: Date };
type Reset = {
  accountId: string;
  epoch: number;
  live: boolean;
  captured: boolean;
  sent: boolean;
  failed: boolean;
  sourceId?: string;
  sourceAmbiguous?: boolean;
  locator?: Locator;
};
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Private to one service and one native reset call; never installed from HTTP evidence. */
export function recoveryDelivery(database: Pool, delivery: AuthServiceOptions['recoveryDelivery'], issuer = '') {
  const scope = new AsyncLocalStorage<Reset>();
  const hooks: VerificationHooks = {
    create: {
      after: async (verification, context) => {
        const reset = scope.getStore();
        if (!reset?.live || context?.path !== '/request-password-reset') return;
        // The installed Better Auth createWithHooks calls this with the INSERT
        // result, before requestPasswordReset calls sendResetPassword. No lookup
        // can establish which row this call created when identifiers repeat.
        if (reset.captured) {
          delete reset.locator;
          return;
        }
        reset.captured = true;
        if (
          !verification.id ||
          reset.sourceAmbiguous ||
          verification.id !== reset.sourceId ||
          verification.value !== reset.accountId ||
          !verification.identifier.startsWith('reset-password:') ||
          !(verification.expiresAt instanceof Date) ||
          verification.expiresAt.getTime() <= Date.now() ||
          verification.expiresAt.getTime() > Date.now() + 300000
        )
          return;
        reset.locator = {
          id: verification.id,
          accountId: verification.value,
          proofHash: hash(verification.identifier.slice('reset-password:'.length)),
          expiresAt: new Date(verification.expiresAt),
        };
      },
    },
  };
  return {
    hooks,
    async run<T>(
      selected: { accountId: string; epoch: number },
      action: () => Promise<T>,
      outcome?: { failed: boolean },
    ): Promise<T> {
      const reset: Reset = { ...selected, live: true, captured: false, sent: false, failed: false };
      try {
        return await scope.run(reset, () => nativeRecoverySource.run(reset, action));
      } finally {
        // Better Auth awaits sendResetPassword and logs its rejection without
        // rejecting requestPasswordReset. The caller still has to release state.
        if (outcome) outcome.failed = reset.failed;
        reset.live = false;
        delete reset.locator;
        delete reset.sourceId;
      }
    },
    async send({ user, token }: { user: { id: string; email: string }; token: string }) {
      const reset = scope.getStore();
      try {
        await deliverReset(reset, user, token);
      } catch (error) {
        if (reset) reset.failed = true;
        throw error;
      }
    },
  };
  async function deliverReset(reset: Reset | undefined, user: { id: string; email: string }, token: string) {
    const locator = reset?.live ? reset.locator : undefined;
    // Missing, ambiguous, wrong-owner or wrong-token provenance cannot deliver
    // or mint a recovery proof, and never falls back to an identifier query.
    if (
      !reset ||
      reset.sent ||
      !locator ||
      !delivery ||
      user.id !== reset.accountId ||
      locator.proofHash !== hash(token)
    )
      throw new Error('Recovery delivery provenance unavailable');
    reset.sent = true;
    let inserted = false;
    let dispatched = false;
    let code: RecoveryCopyCode = 'callback-failed';
    try {
      if (locator.expiresAt.getTime() <= Date.now()) throw new Error('Recovery delivery expired');
      const source = await readRecoveryCopySource(database, locator.id);
      if (
        !source ||
        source.roles.account_id !== locator.accountId ||
        source.expiresAt.getTime() !== locator.expiresAt.getTime()
      )
        throw new Error('Recovery delivery provenance unavailable');
      await database.query(
        'INSERT INTO auth_recovery (proof_hash, account_id, authn_epoch, expires_at) VALUES ($1,$2,$3,$4)',
        [locator.proofHash, locator.accountId, reset.epoch, locator.expiresAt],
      );
      inserted = true;
      await beginRecoveryCopyDisclosure(database, locator.id, locator.accountId);
      dispatched = true;
      // No leased Auth connection or producer lock spans the receiver call.
      // The legacy callback cannot be cancelled; a timeout leaves any late copy
      // unresolved under this SAME delivery identity and never starts a resend.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() =>
            delivery.deliver({
              deliveryId: locator.id,
              accountId: user.id,
              email: user.email,
              token,
              expiresAt: new Date(locator.expiresAt),
              url: `${issuer}/recovery#account_id=${encodeURIComponent(user.id)}&token=${encodeURIComponent(token)}`,
            }),
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              code = 'callback-timeout';
              reject(new Error('Recovery delivery failed'));
            }, 5000);
          }),
        ]);
        // Promise<void> has no receiving result contract. Consume zero response
        // bytes: never decode/stringify arbitrary return objects, provider
        // payloads or thenable receipts as a <=64KiB verified result.
        code = result === undefined ? 'legacy-void' : 'unsupported-result';
      } finally {
        if (timer) clearTimeout(timer);
      }
      // A lost technical checkpoint cannot revoke an otherwise successful
      // recovery proof. The committed in-flight row already keeps custody open.
      await finishRecoveryCopyDisclosure(database, locator.id, code).catch(() => {});
    } catch {
      // Do not delete an earlier proof if this request's INSERT conflicted.
      // Invalidate the undelivered proof first; both deletes are idempotent PK
      // operations. The hook bound this ID to the owner, token hash and expiry.
      try {
        if (dispatched) await finishRecoveryCopyDisclosure(database, locator.id, code);
      } catch {
        // The durable in-flight state already retains the ambiguity.
      }
      try {
        if (inserted)
          await database.query(
            'DELETE FROM auth_recovery WHERE proof_hash=$1 AND account_id=$2 AND authn_epoch=$3 AND expires_at=$4 AND consumed_operation IS NULL',
            [locator.proofHash, locator.accountId, reset.epoch, locator.expiresAt],
          );
        await database.query('DELETE FROM verification WHERE id=$1 AND value=$2 AND "expiresAt"=$3', [
          locator.id,
          locator.accountId,
          locator.expiresAt,
        ]);
      } catch {
        // Cleanup failures must not forward SQL parameters or sink contents.
      }
      // Better Auth logs callback errors. Never forward sink errors that might
      // embed mail contents, the public token or the password.
      throw new Error('Recovery delivery failed');
    }
  }
}
