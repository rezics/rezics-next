import { DocumentBody as SharedDocumentBody } from '@rezics/ui/document-body';
import type { ComponentProps } from 'react';
import { m } from './paraglide/messages.js';
import { getLocale } from './paraglide/runtime.js';

export type { DocumentMentions } from '@rezics/ui/document-body';

/** Supply Web's reader locale and messages while retaining the caller's image renderer. */
export function DocumentBody({ locale = getLocale(), labels, ...props }: ComponentProps<typeof SharedDocumentBody>) {
  const options = { locale: locale as never };
  return (
    <SharedDocumentBody
      {...props}
      locale={locale}
      labels={{
        revealSpoiler: m.thread_reveal_spoiler({}, options),
        taskStatus: m.document_task_status({}, options),
        embeddedComponent: m.document_embedded_component({}, options),
        imageUnavailable: m.content_edition_image_unavailable({}, options),
        ...labels,
      }}
    />
  );
}
