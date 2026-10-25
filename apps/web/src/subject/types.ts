import type { KernelClient } from '@rezics/client';

type Read = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['get']>>['data']>;
export type Subject = Read['subject'];
export type Related = Read['related'] & Record<string, Read['related'][string] & {
  /** The kernel type will carry the survivor id for merged subjects. */
  redirect?: string;
}>;
