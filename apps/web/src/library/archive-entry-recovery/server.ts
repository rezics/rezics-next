import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareExpectedReader, validExpectedReader, type ExpectedReader } from '../../session/expected-reader';
import type { SessionEnv } from '../../session/client';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from '../entry-restore-credential';
import { archiveRecoveryNative, type ArchiveRecoveryPort } from './native';

/** Existing private command credential custody also preserves the archive sender across retries. */
export const archiveRecoverySender = createServerFn({ method: 'POST' })
  .validator((input: unknown): ExpectedReader => {
    if (!validExpectedReader(input)) throw new Error('Invalid archive viewer');
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    if (!(await prepareExpectedReader(request, env as Partial<SessionEnv>, data)))
      throw new Error('Archive viewer changed');
    return await captureEntryRestoreCredential(request, env as Partial<SessionEnv>);
  });

type Operation = keyof ArchiveRecoveryPort;
type Command = { [K in Operation]: { operation: K; args: Parameters<ArchiveRecoveryPort[K]> } }[Operation];
type Input = Command & ExpectedReader & { sender?: string };

// The server-function request is an HTTP boundary. Native routes validate operation operands;
// the archive itself travels as untouched text to the existing decoder.
function validate(input: unknown): Input {
  if (!validExpectedReader(input) || !('operation' in input) || !('args' in input) || !Array.isArray(input.args))
    throw new Error('Invalid archive command');
  const operations: Operation[] = [
    'upload',
    'status',
    'preview',
    'review',
    'apply',
    'results',
    'cancel',
    'prune',
    'entry',
    'personal',
    'journal',
    'label',
  ];
  if (!operations.includes(input.operation as Operation)) throw new Error('Invalid archive operation');
  if ('sender' in input && (typeof input.sender !== 'string' || input.sender.length > 3200))
    throw new Error('Invalid archive sender');
  return input as Input;
}

export const archiveRecoveryCall = createServerFn({ method: 'POST' })
  .validator(validate)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    if (!(await prepareExpectedReader(request, env as Partial<SessionEnv>, data)))
      throw new Error('Archive viewer changed');
    const authorization = await originalEntryRestoreCredential(request, env as Partial<SessionEnv>, data.sender);
    if (!authorization) throw new Error('Archive sender changed');
    const port = archiveRecoveryNative(kernelClient(), authorization);
    // Keep dispatch concrete so the generated publisher remains the only transport authority.
    switch (data.operation) {
      case 'upload':
        return port.upload(...data.args);
      case 'status':
        return port.status(...data.args);
      case 'preview':
        return port.preview(...data.args);
      case 'review':
        return port.review(...data.args);
      case 'apply':
        return port.apply(...data.args);
      case 'results':
        return port.results(...data.args);
      case 'cancel':
        return port.cancel(...data.args);
      case 'prune':
        return port.prune(...data.args);
      case 'entry':
        return port.entry(...data.args);
      case 'personal':
        return port.personal(...data.args);
      case 'journal':
        return port.journal(...data.args);
      case 'label':
        return port.label(...data.args);
    }
  });
