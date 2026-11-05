import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import { prepareExpectedReader, validExpectedReader, type ExpectedReader } from '../../session/expected-reader';
import type { SessionEnv } from '../../session/client';
import { readReleaseForCaller } from '../../subject/definitions';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from '../entry-restore-credential';
import { progressFormChoices } from '../progress-profile';
import { progressRecoveryNative, type NativePort, UPLOAD_BYTES } from './native';

export const progressRecoverySender = createServerFn({ method: 'POST' })
  .validator((input: unknown): ExpectedReader => {
    if (!validExpectedReader(input)) throw new Error('Invalid archive viewer');
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    if (!(await prepareExpectedReader(request, env as Partial<SessionEnv>, data)))
      throw new Error('Archive viewer changed');
    return captureEntryRestoreCredential(request, env as Partial<SessionEnv>);
  });

type Command = { [K in keyof NativePort]: { operation: K; args: Parameters<NativePort[K]> } }[keyof NativePort];
type Input = Command & ExpectedReader & { sender?: string };
const operations = [
  'upload',
  'holdings',
  'occurrences',
  'units',
  'review',
  'apply',
  'result',
  'cancel',
  'remove',
  'subject',
];
function validate(input: unknown): Input {
  if (
    !validExpectedReader(input) ||
    !('operation' in input) ||
    typeof input.operation !== 'string' ||
    !operations.includes(input.operation) ||
    !('args' in input) ||
    !Array.isArray(input.args)
  )
    throw new Error('Invalid archive command');
  if ('sender' in input && (typeof input.sender !== 'string' || input.sender.length > 3200))
    throw new Error('Invalid archive sender');
  // The RPC envelope is external input. Native routes own each operand's semantic validation.
  if (
    input.operation === 'upload' &&
    (typeof input.args[0] !== 'string' || input.args[0].length > 4 * Math.ceil(UPLOAD_BYTES / 3))
  )
    throw new Error('Archive exceeds 32 MiB');
  return input as Input;
}
export const progressRecoveryCall = createServerFn({ method: 'POST' })
  .validator(validate)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    if (!(await prepareExpectedReader(request, env as Partial<SessionEnv>, data)))
      throw new Error('Archive viewer changed');
    const authorization = await originalEntryRestoreCredential(request, env as Partial<SessionEnv>, data.sender);
    if (!authorization) throw new Error('Archive sender changed');
    const client = kernelClient(),
      port = progressRecoveryNative(client, authorization);
    // The generated evidence contains opaque historical JSON. Carry it as JSON text through the RPC serializer.
    switch (data.operation) {
      case 'upload':
        return JSON.stringify(await port.upload(...data.args));
      case 'holdings':
        return JSON.stringify(await port.holdings(...data.args));
      case 'occurrences':
        return JSON.stringify(await port.occurrences(...data.args));
      case 'units':
        return JSON.stringify(await port.units(...data.args));
      case 'review':
        return JSON.stringify(await port.review(...data.args));
      case 'apply':
        return JSON.stringify(await port.apply(...data.args));
      case 'result':
        return JSON.stringify(await port.result(...data.args));
      case 'cancel':
        return JSON.stringify(await port.cancel(...data.args));
      case 'remove':
        return JSON.stringify(await port.remove(...data.args));
      case 'subject':
        return JSON.stringify(await port.subject(...data.args));
    }
  });

export const progressRecoveryChoices = createServerFn({ method: 'POST' })
  .validator((input: unknown): ExpectedReader & { subjectId: string } => {
    if (
      !validExpectedReader(input) ||
      !('subjectId' in input) ||
      typeof input.subjectId !== 'string' ||
      !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.subjectId)
    )
      throw new Error('Invalid Subject');
    return { ...input, subjectId: input.subjectId };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const authorization = await prepareExpectedReader(request, env as Partial<SessionEnv>, data);
    if (!authorization) throw new Error('Archive viewer changed');
    const client = kernelClient();
    const [subject, release] = await Promise.all([
      progressRecoveryNative(client, authorization).subject(data.subjectId),
      readReleaseForCaller({ client, headers: { authorization } }),
    ]);
    if (subject.kind !== 'ok') return subject;
    return {
      kind: 'ok' as const,
      value: {
        subjectId: data.subjectId,
        choices: progressFormChoices(release, subject.value.subject.type, requestLocale(request) ?? 'en'),
      },
    };
  });
