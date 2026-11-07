import { describe, expect, it } from 'bun:test';
import {
  acceptCandidateReading,
  candidateReadingIdentity,
  type CandidateReading,
} from '../src/features/pages/candidate-reading-application';

const request = { candidate: 'quotation-visit', locale: 'en', address: ['subject', 'context'] } as const;

function reading(active: () => boolean = () => true): CandidateReading {
  return {
    candidate: request.candidate,
    locale: request.locale,
    identity: candidateReadingIdentity(request),
    reader: 'reader',
    generation: 7,
    active,
    live: active,
    retire: () => undefined,
  };
}

describe('page candidate readings', () => {
  it('binds identity to candidate, locale and the native address', () => {
    const identity = candidateReadingIdentity(request);
    expect(candidateReadingIdentity({ ...request, locale: 'zh-Hant' })).not.toBe(identity);
    expect(candidateReadingIdentity({ ...request, address: ['other-subject', 'context'] })).not.toBe(identity);
    expect(candidateReadingIdentity({ ...request, candidate: 'source-concept' })).not.toBe(identity);
  });

  it('accepts only a result owned by the still-current visit', () => {
    expect(acceptCandidateReading(reading(), request, 'page')).toMatchObject({ kind: 'accepted', value: 'page' });
    expect(acceptCandidateReading(reading(), { ...request, address: ['replacement', 'context'] }, 'late')).toEqual({
      kind: 'retired',
    });
    expect(
      acceptCandidateReading(
        reading(() => false),
        request,
        'late',
      ),
    ).toEqual({ kind: 'retired' });
  });
});
