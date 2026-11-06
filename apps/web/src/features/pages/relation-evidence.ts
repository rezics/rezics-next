import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { isRecord } from './shared';
import { readRelationEvidence, type RelationEvidenceRequest } from './relation-evidence-read';
import { validateViewCursor } from './view-cursor';

export type {
  RelationEvidenceCandidate,
  RelationEvidenceRead,
  RelationEvidenceRequest,
} from './relation-evidence-read';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const curiePattern = /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_.-]+$/;
const cursorLimit = 8192;

/** Evidence for one exact relation slot of a Global reading. */
export const loadRelationEvidence = createServerFn({ method: 'GET', strict: false })
  .validator((value: unknown): RelationEvidenceRequest => {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => !['subject', 'locale', 'reader', 'property', 'target', 'key', 'cursor'].includes(key),
      ) ||
      typeof value.subject !== 'string' ||
      !uuidPattern.test(value.subject) ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35 ||
      (value.reader !== undefined &&
        value.reader !== null &&
        (typeof value.reader !== 'string' || !value.reader || value.reader.length > 128)) ||
      typeof value.property !== 'string' ||
      value.property.length > 128 ||
      !curiePattern.test(value.property) ||
      typeof value.target !== 'string' ||
      !uuidPattern.test(value.target) ||
      (value.key !== undefined && (typeof value.key !== 'string' || !uuidPattern.test(value.key))) ||
      (typeof value.cursor === 'string' && value.cursor.length > cursorLimit)
    )
      throw notFound();
    return {
      subject: value.subject,
      locale: value.locale,
      reader: value.reader as string | null | undefined,
      property: value.property,
      target: value.target,
      key: value.key as string | undefined,
      cursor: validateViewCursor(value.cursor),
    };
  })
  .handler(async ({ data }) => {
    const { subjectKernelClient } = await import('./subject-queries');
    setResponseHeader('cache-control', 'private, no-store');
    const { client, authorization } =
      data.reader === null
        ? { client: (await import('../../kernel/client')).kernelClient(data.locale), authorization: undefined }
        : await subjectKernelClient(data.locale, undefined, data.reader);
    return readRelationEvidence(client, data, authorization, getRequest().signal);
  });
