import type { KernelClient } from '@rezics/client';
import type { CopyItem } from './copies-read';

export type NativeCopy = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['copies']>['get']>>['data']
>['copy'];
type NativeField<T, Key extends PropertyKey> = Key extends keyof T ? T[Key] : never;
export type NativeCopyPresentation = NonNullable<NativeField<NativeCopy, 'presentation'>>;
type DetailOptions = NonNullable<Parameters<ReturnType<KernelClient['copies']>['get']>[0]>;
type DetailQuery = NonNullable<NativeField<DetailOptions, 'query'>>;
type PresentationQuery = Extract<NativeField<DetailQuery, 'presentation'>, 'FULL'>;

// The generated producer on this base has neither presentation nor its closed query member.
// These compile-time tripwires require replacing this pending seam when the actual DTO lands.
const pendingBody: [NativeCopyPresentation] extends [never] ? true : never = true;
const pendingQuery: [PresentationQuery] extends [never] ? true : never = true;

export function nativeCopyPresentationQuery(): { presentation: PresentationQuery } | undefined {
  void pendingQuery;
  return undefined;
}

/** Never trust undeclared additions or derive accepted meaning from the current definitions head. */
export function nativeCopyPresentation(_copy: NativeCopy): Pick<CopyItem, 'meaning' | 'statusEditing'> {
  void pendingBody;
  return { meaning: 'unavailable', statusEditing: { state: 'unavailable' } };
}
