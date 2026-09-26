import type { CaseDeclarations } from './declaration.ts';

export const mediaCases: CaseDeclarations = {
  BOOK09: [
    { tier: 'integration', file: 'tests/qa/integration/media-publication.test.ts',
      name: 'BOOK09: an image-only publication activates exact RustFS images without a fabricated text document' },
    { tier: 'integration', file: 'tests/qa/integration/media-publication.test.ts',
      name: 'BOOK09: a poll-only publication uses the poll owner without creating a text document' },
  ],
};
