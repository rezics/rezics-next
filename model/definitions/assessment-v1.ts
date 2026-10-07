import type { TurtleDeclaration } from '../compiler/shacl.ts';

/** Reliability stays scoped; exact assessment pins and independent-origin limits live in the Turtle author. */
export const assessmentDeclaration = {
  id: 'assessment-v1',
  canonical: {
    'reliability-scope': { types: ['rv:SourceReliabilityScope'] },
    reliability: { types: ['rv:SourceReliabilityAssessment'] },
    assessment: { types: ['rv:ClaimAssessment'] },
  },
} as const satisfies TurtleDeclaration;
