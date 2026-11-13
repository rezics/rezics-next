import type { HostedRootAppendNative, HostedRootAppendRequest } from './hosted-contract';
import {
  HostedDraftCommandVisit,
  type DraftCommandIntent,
  type HostedDraftCommandState,
  type DraftCommandOptions,
  type DraftCommandTransport,
} from './hosted-draft-point-lifecycle';
import { hostedOccurrenceId } from './hosted-structure';

export type RootAppendIntent = DraftCommandIntent<HostedRootAppendRequest>;
export type HostedRootAppendState = HostedDraftCommandState<HostedRootAppendRequest, null>;
export type RootAppendTransport = DraftCommandTransport & HostedRootAppendNative;
type Options = Omit<
  DraftCommandOptions<HostedRootAppendRequest, null>,
  'choice' | 'prepare' | 'send' | 'refreshed' | 'native'
> & { native: RootAppendTransport };

/** One exact chapter specialization of the shared bounded draft command lifecycle. */
export class HostedRootAppendVisit extends HostedDraftCommandVisit<HostedRootAppendRequest, null> {
  constructor(options: Options) {
    super({
      ...options,
      choice: null,
      async prepare(state, key) {
        if (!state.selection || !state.title.trim() || [...state.title.trim()].length > 256) return null;
        const target = options.picker.target(state.selection.revision.exact)!;
        return {
          catalogueId: options.owner.item.catalogueId,
          expectedViewer: { ...options.owner.viewer },
          idempotencyKey: key,
          body: {
            expectedRevisionId: state.head,
            occurrenceId: await hostedOccurrenceId(options.owner.item.catalogueId, key),
            title: state.title.trim(),
            target: { ...target },
          },
        };
      },
      send: (request, signal, csrf) => options.native.appendRootChapter(request, signal, csrf),
    });
  }
}
