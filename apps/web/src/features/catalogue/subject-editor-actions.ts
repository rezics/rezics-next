import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { originalReaderInput } from './editor-reader-input';
import { kernelClient, requestLocale } from '../../kernel/client';
import { SELECTED_SYNOPSIS_VISIT_ADDRESS_BYTE_CAP } from './selected-synopsis-source';
import { readSelectedSynopsisEditor, type SelectedSynopsisEditorInspection } from './subject-editor';
import { selectedEditorAttempt } from './subject-editor-lifetime';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function editorInspectionAddress(value: unknown): {
  id: string;
  via?: string;
  property?: string;
  session?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid selected editor address');
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    (input.property !== undefined && (typeof input.property !== 'string' || input.property.length > 256)) ||
    (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384)) ||
    (input.via !== undefined &&
      (typeof input.via !== 'string' ||
        new TextEncoder().encode(input.via).byteLength > SELECTED_SYNOPSIS_VISIT_ADDRESS_BYTE_CAP))
  )
    throw new Error('Invalid selected editor address');
  return {
    id: input.id,
    ...(typeof input.via === 'string' ? { via: input.via } : {}),
    ...(typeof input.property === 'string' ? { property: input.property } : {}),
    ...(typeof input.session === 'string' ? { session: input.session } : {}),
  };
}

/** Inspection only: via is intent, never a draft, credential or command. */
export const inspectSubjectEditor = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(editorInspectionAddress))
  .handler(async ({ data }): Promise<{ inspection: SelectedSynopsisEditorInspection }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale() ?? 'en';
    const result = await readSelectedSynopsisEditor(
      kernelClient(locale),
      {
        id: data.id,
        locale,
        ...(data.via !== undefined ? { via: data.via } : {}),
        ...(data.property !== undefined ? { property: data.property } : {}),
        ...(data.session !== undefined ? { session: data.session } : {}),
      },
      selectedEditorAttempt().start(),
    );
    return { inspection: result.inspection };
  });
