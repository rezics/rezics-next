import type { KernelClient } from '@rezics/client';
import { m } from '../paraglide/messages.js';

export type VerificationInput = {
  subject: string;
  statement: string;
  links: { label: string; url: string }[];
  idempotencyKey: string;
};

type VerificationResponse = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['accounts']>['verification']['get']>>['data']
>;
export type AgentVerificationRequest = NonNullable<VerificationResponse['verificationRequest']>;

export type VerificationCommandResult =
  | { ok: true; verificationRequest: AgentVerificationRequest }
  | { ok: false; status: number; message: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function apiMessage(error: unknown): string {
  if (record(error) && record(error.value) && typeof error.value.detail === 'string') return error.value.detail;
  return m.settings_verification_request_failed();
}

export async function readVerification(client: KernelClient, accountId: string, authorization: string) {
  const result = await client.accounts({ accountId }).verification.get({ headers: { authorization } });
  if (result.error || !result.data) throw new Error(apiMessage(result.error));
  return result.data.verificationRequest;
}

export async function requestVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  input: VerificationInput,
): Promise<VerificationCommandResult> {
  const invalid =
    !input.subject ||
    !input.statement.trim() ||
    input.statement.length > 2000 ||
    input.links.length > 5 ||
    input.links.some((link) => !link.label.trim() || !link.url.trim());
  if (invalid) return { ok: false, status: 0, message: m.settings_verification_validation() };
  const result = await client
    .accounts({ accountId })
    .$requestVerification.post(
      { subject: input.subject, statement: input.statement, links: input.links },
      { headers: { authorization, 'idempotency-key': input.idempotencyKey } as { 'idempotency-key': string } },
    );
  if (result.status === 201 && result.data) return { ok: true, verificationRequest: result.data.verificationRequest };
  return { ok: false, status: result.status, message: apiMessage(result.error) };
}

export async function withdrawVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  idempotencyKey: string,
): Promise<VerificationCommandResult> {
  const result = await client.accounts({ accountId }).$withdrawVerification.post(
    {},
    {
      headers: { authorization, 'idempotency-key': idempotencyKey } as { 'idempotency-key': string },
    },
  );
  if (result.status === 200 && result.data) return { ok: true, verificationRequest: result.data.verificationRequest };
  return { ok: false, status: result.status, message: apiMessage(result.error) };
}
