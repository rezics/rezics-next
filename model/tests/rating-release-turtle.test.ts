import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { shapeSchemas } from '../../packages/model/src/generated/schemas.ts';
import { ratingAggregateDefaultPolicyProfile } from '../definitions/rating-aggregate-default-policy-v1.ts';
import { ratingQuestionPresentationProfile } from '../definitions/rating-question-presentation-v1.ts';
import { ratingQuestionPresentationReviewedProfile } from '../definitions/rating-question-presentation-v2.ts';
import { releaseProfile } from '../definitions/release-v1.ts';
import { releaseV2Profile } from '../definitions/release-v2.ts';
import { releaseV3Profile } from '../definitions/release-v3.ts';

const definition = 'https://rezics.com/definition/';
const vocabulary = 'https://rezics.com/vocab/';
const ids = [
  'rating-aggregate-default-policy-v1',
  'rating-question-presentation-v1',
  'rating-question-presentation-v2',
  'release-v1',
  'release-v2',
  'release-v3',
] as const;

const originalPins = {
  'rating-aggregate-default-policy-v1':
    '0d9a0acbe78f4043628960ed5942b64bc7a90d915e5e1fe0cb40938bda5f6fe4',
  'rating-question-presentation-v1':
    '24eaf5f83260d123b17352236a947f08367d7ecc4d5df681f44825d457d28767',
  'rating-question-presentation-v2':
    '627c0879d09b1e05286536be5830f582e9a6a4cabc4620c1adf3a9ee0b84134e',
  'release-v1': 'e0018a2144113c2c3cc6bfcdc3951f1ce282c919859950c0811aa018c4a1c92c',
  'release-v2': '2f582286d19af2061cc01e2c80cc53813a9437a6b2a855ef578435e5261162f5',
  'release-v3': '1c6febcd2ce283307c8aaff5722e54b38e84dedb5a3151741d374516c420b83b',
} as const;

const focusRoles = {
  'rating-aggregate-default-policy-v1': ['context', 'revision'],
  'rating-question-presentation-v1': ['presentation', 'revision'],
  'rating-question-presentation-v2': ['presentation', 'revision'],
  'release-v1': ['release', 'revision'],
  'release-v2': ['release', 'revision'],
  'release-v3': ['release', 'coverage', 'revision'],
} as const;

const canonicalRoutes = {
  'rating-aggregate-default-policy-v1': [
    { role: 'revision', type: `${vocabulary}RatingPolicyRevision`, when: [] },
  ],
  'rating-question-presentation-v1': [
    { role: 'presentation', type: `${vocabulary}RatingQuestionPresentation`, when: [] },
    { role: 'revision', type: `${vocabulary}RatingQuestionPresentationRevision`, when: [] },
  ],
  'rating-question-presentation-v2': [
    { role: 'presentation', type: `${vocabulary}RatingQuestionPresentationV2`, when: [] },
    { role: 'revision', type: `${vocabulary}RatingQuestionPresentationV2Revision`, when: [] },
  ],
  'release-v1': [
    { role: 'release', type: `${vocabulary}Release`, when: [] },
    { role: 'revision', type: `${vocabulary}ReleaseRevision`, when: [] },
  ],
  'release-v2': [
    {
      role: 'release',
      type: `${vocabulary}Release`,
      when: [{ path: `${vocabulary}definitionProfile`, value: `${definition}release-v2` }],
    },
    {
      role: 'revision',
      type: `${vocabulary}ReleaseRevision`,
      when: [{ path: `${vocabulary}modelRevision`, value: `${definition}release-v2` }],
    },
  ],
  'release-v3': [
    { role: 'coverage', type: `${vocabulary}ReleaseCoverage`, when: [] },
    {
      role: 'release',
      type: `${vocabulary}Release`,
      when: [{ path: `${vocabulary}definitionProfile`, value: `${definition}release-v3` }],
    },
    {
      role: 'revision',
      type: `${vocabulary}ReleaseRevision`,
      when: [{ path: `${vocabulary}modelRevision`, value: `${definition}release-v3` }],
    },
  ],
} as const;

const manifestBindings = {
  'rating-aggregate-default-policy-v1': {
    required: ['context', 'revision', 'contextRevision', 'predecessor', 'aggregationPolicy'],
    optional: [],
    roles: ['context', 'revision'],
  },
  'rating-question-presentation-v1': {
    required: ['presentation', 'revision', 'context', 'language'],
    optional: [],
    roles: ['presentation', 'revision'],
  },
  'rating-question-presentation-v2': {
    required: ['presentation', 'revision', 'context', 'language'],
    optional: [],
    roles: ['presentation', 'revision'],
  },
  'release-v1': undefined,
  'release-v2': undefined,
  'release-v3': undefined,
} as const;

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const role = (iri: string) => iri.split('/').at(-1)!.slice(0, -6);
const profileById = new Map(authoredProfiles.map((profile) => [profile.id, profile]));
const namedProfiles = [
  ratingAggregateDefaultPolicyProfile,
  ratingQuestionPresentationProfile,
  ratingQuestionPresentationReviewedProfile,
  releaseProfile,
  releaseV2Profile,
  releaseV3Profile,
];

test('rating and release Turtle preserves source pins, focus, routes and command bindings', () => {
  const command = commandProfiles(authoredProfiles);
  const published = new Map(command.profiles.map((profile) => [profile.id, profile]));
  const manifestProfiles = command.manifest.profiles as { id: string; binding?: unknown }[];
  const registryRoutes = command.manifest.canonical as {
    type: string;
    routes: { profile: string; shape: string; when: { path: string; value: string }[] }[];
  }[];

  expect(namedProfiles.map((profile) => profile.id)).toEqual([...ids]);
  for (const id of ids) {
    const profile = profileById.get(id)!;
    const pin = originalPins[id];
    const source = readFileSync(new URL(`../definitions/${id}.ttl`, import.meta.url), 'utf8');
    const routes = registryRoutes
      .flatMap(({ type, routes: entries }) =>
        entries
          .filter((entry) => entry.profile === id)
          .map((entry) => ({ role: role(entry.shape), type, when: entry.when })),
      )
      .sort(
        (left, right) => left.role.localeCompare(right.role) || left.type.localeCompare(right.type),
      );

    expect(digest(profileSource(profile))).toBe(pin);
    expect(profileRegistry[id].sha256).toBe(pin);
    expect(published.get(id)?.sha256).toBe(pin);
    expect(published.get(id)?.focusRoles).toEqual(focusRoles[id]);
    expect(profile.shapes.map((shape) => role(shape.iri))).toEqual(focusRoles[id]);
    expect(routes).toEqual(
      [...canonicalRoutes[id]].sort(
        (left, right) => left.role.localeCompare(right.role) || left.type.localeCompare(right.type),
      ),
    );
    expect(
      Object.fromEntries(
        profile.shapes.flatMap((shape) => (shape.or ? [[role(shape.iri), shape.or.length]] : [])),
      ),
    ).toEqual({});
    expect(manifestProfiles.find((entry) => entry.id === id)?.binding).toEqual(
      manifestBindings[id],
    );
    expect(isTurtleProfile(profile)).toBe(true);
    expect(profileSource(profile)).toBe(source);
    expect(command.shapes.get(`shapes/${id}.ttl`)).toBe(source);
  }
  expect(ratingAggregateDefaultPolicyProfile.binding).toBeUndefined();
  expect(releaseProfile.binding).toBeUndefined();
  expect(releaseV2Profile.binding).toBeUndefined();
  expect(releaseV3Profile.binding).toBeUndefined();
});

test('aggregate policy successors keep the question head and the three admitted reductions', () => {
  const context = {
    '@id': 'urn:rating:context',
    'rdf:type': [`${vocabulary}RatingContext`, `${vocabulary}ExperienceRatingContext`],
    'rv:contextState': [`${vocabulary}Active`],
    'rv:head': ['urn:rating:question-revision'],
    'rv:ratingPolicyHead': ['urn:rating:policy-revision'],
    'rv:ratingAggregationPolicy': [`${definition}rating-latest-per-rater-mean-v1`],
    'rv:ratingCadence': [`${definition}rating-experience-v1`],
  };
  const revision = {
    '@id': 'urn:rating:policy-revision',
    'rdf:type': [`${vocabulary}RatingPolicyRevision`, `${vocabulary}RevisionAnchor`],
    'rv:component': ['urn:rating:context'],
    'rv:contextRevision': ['urn:rating:question-revision'],
    'rv:predecessor': ['urn:rating:policy-prior'],
    'rv:ratingAggregationPolicy': [`${definition}rating-mean-per-rater-v1`],
    'rv:modelRevision': [`${definition}rating-aggregate-default-policy-v1`],
    'rv:manifest': ['urn:manifest:policy'],
  };
  const contextShape =
    shapeSchemas[`${definition}rating-aggregate-default-policy-v1/context-shape`];
  const revisionShape =
    shapeSchemas[`${definition}rating-aggregate-default-policy-v1/revision-shape`];

  expect(Value.Check(contextShape, context)).toBe(true);
  expect(
    Value.Check(contextShape, {
      ...context,
      'rv:ratingAggregationPolicy': [`${definition}rating-mean-per-rater-v1`],
    }),
  ).toBe(false);
  for (const policy of [
    'rating-latest-per-rater-mean-v1',
    'rating-mean-per-rater-v1',
    'rating-pooled-observation-mean-v1',
  ]) {
    expect(
      Value.Check(revisionShape, {
        ...revision,
        'rv:ratingAggregationPolicy': [`${definition}${policy}`],
      }),
    ).toBe(true);
  }
  expect(
    Value.Check(revisionShape, {
      ...revision,
      'rv:ratingAggregationPolicy': [`${definition}rating-unreviewed-v1`],
    }),
  ).toBe(false);
});

test('question presentations keep one language head and reject an unreviewed status', () => {
  const presentation = {
    '@id': 'urn:presentation:current',
    'rdf:type': [`${vocabulary}RatingQuestionPresentation`],
    'rv:questionPresentationHead': ['urn:presentation:revision'],
    'rv:presentationContext': ['urn:rating:context'],
    'rv:presentationLanguage': ['en'],
  };
  const revision = {
    '@id': 'urn:presentation:revision',
    'rdf:type': [`${vocabulary}RatingQuestionPresentationRevision`, `${vocabulary}RevisionAnchor`],
    'rv:component': ['urn:presentation:current'],
    'rv:presentationContext': ['urn:rating:context'],
    'rv:presentationLanguage': ['en'],
    'rv:question': [{ '@value': 'How good is this?', '@language': 'en' }],
    'rv:source': ['author'],
    'rv:licence': ['https://rezics.com/licence/question'],
    'rv:reviewStatus': [`${vocabulary}Draft`],
    'rv:operation': ['urn:operation:presentation'],
    'rv:manifest': ['urn:manifest:presentation'],
    'rv:modelGeneration': ['urn:model:generation'],
    'rv:modelRevision': [`${definition}rating-question-presentation-v1`],
    'rv:shapeRevision': [`${definition}rating-question-presentation-v1`],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': ['epoch'],
    'rv:sequence': [1],
  };
  const reviewed = {
    ...presentation,
    'rdf:type': [`${vocabulary}RatingQuestionPresentationV2`],
    'rv:questionPresentationReviewedHead': ['urn:presentation:reviewed'],
  };
  const reviewedRevision = {
    ...revision,
    'rdf:type': [
      `${vocabulary}RatingQuestionPresentationV2Revision`,
      `${vocabulary}RevisionAnchor`,
    ],
    'rv:component': ['urn:presentation:reviewed'],
    'rv:reviewStatus': [`${vocabulary}Reviewed`],
    'rv:modelRevision': [`${definition}rating-question-presentation-v2`],
    'rv:shapeRevision': [`${definition}rating-question-presentation-v2`],
  };

  expect(
    Value.Check(
      shapeSchemas[`${definition}rating-question-presentation-v1/presentation-shape`],
      presentation,
    ),
  ).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}rating-question-presentation-v1/presentation-shape`], {
      ...presentation,
      'rv:head': ['urn:rating:question-revision'],
    }),
  ).toBe(false);
  expect(
    Value.Check(
      shapeSchemas[`${definition}rating-question-presentation-v1/revision-shape`],
      revision,
    ),
  ).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}rating-question-presentation-v1/revision-shape`], {
      ...revision,
      'rv:reviewStatus': [`${vocabulary}Pending`],
    }),
  ).toBe(false);
  expect(
    Value.Check(
      shapeSchemas[`${definition}rating-question-presentation-v2/presentation-shape`],
      reviewed,
    ),
  ).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}rating-question-presentation-v2/presentation-shape`], {
      '@id': reviewed['@id'],
      'rdf:type': reviewed['rdf:type'],
      'rv:questionPresentationHead': reviewed['rv:questionPresentationHead'],
      'rv:presentationContext': reviewed['rv:presentationContext'],
      'rv:presentationLanguage': reviewed['rv:presentationLanguage'],
    }),
  ).toBe(true);
  expect(
    Value.Check(
      shapeSchemas[`${definition}rating-question-presentation-v2/revision-shape`],
      reviewedRevision,
    ),
  ).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}rating-question-presentation-v2/revision-shape`], {
      ...reviewedRevision,
      'rv:question': [{ '@value': 'No', '@language': 'en' }],
    }),
  ).toBe(false);
});

test('release kinds, coverage entries and profile discriminators stay distinct', () => {
  const release = {
    '@id': 'urn:release:one',
    'rdf:type': [`${vocabulary}Release`],
    'rv:work': ['urn:work:one'],
    'rv:releaseKind': ['virtual'],
    'rv:releaseStatus': ['virtual'],
    'rv:releaseHead': ['urn:release:revision'],
  };
  const revision = {
    '@id': 'urn:release:revision',
    'rdf:type': [`${vocabulary}ReleaseRevision`, `${vocabulary}RevisionAnchor`],
    'rv:component': ['urn:release:one'],
    'rv:releaseState': ['virtual'],
    'rv:manifest': ['urn:manifest:release'],
    'rv:modelRevision': [`${definition}release-v1`],
    'rv:shapeRevision': [`${definition}release-v1`],
    'rv:dataEpoch': ['epoch'],
    'rv:sequence': [1],
  };
  const covered = {
    ...release,
    'rv:releaseKind': ['formal'],
    'rv:releaseStatus': ['official'],
    'rv:coverageWork': ['urn:work:one'],
    'rv:definitionProfile': [`${definition}release-v2`],
    'rv:coverageRealization': ['urn:realization:one'],
    'rv:coverageRevision': ['urn:realization:revision'],
    'rv:contentLanguage': ['en'],
    'rv:completeness': ['complete'],
    'rv:territory': ['US'],
    'rv:isbn13': ['9780306406157'],
  };
  const entry = {
    '@id': 'urn:release:coverage',
    'rdf:type': [`${vocabulary}ReleaseCoverage`],
    'rv:work': ['urn:work:one'],
    'rv:realization': ['urn:realization:one'],
    'rv:revision': ['urn:realization:revision'],
    'rv:contentLanguage': ['en'],
    'rv:completeness': ['partial'],
  };

  expect(Value.Check(shapeSchemas[`${definition}release-v1/release-shape`], release)).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}release-v1/release-shape`], {
      ...release,
      'rv:releaseKind': ['bootleg'],
    }),
  ).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}release-v1/revision-shape`], revision)).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}release-v1/revision-shape`], {
      ...revision,
      'rv:sequence': [0],
    }),
  ).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}release-v2/release-shape`], covered)).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}release-v2/release-shape`], {
      ...covered,
      'rv:territory': ['usa'],
    }),
  ).toBe(false);
  expect(
    Value.Check(shapeSchemas[`${definition}release-v2/release-shape`], {
      ...covered,
      'rv:definitionProfile': [`${definition}release-v1`],
    }),
  ).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}release-v3/coverage-shape`], entry)).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}release-v3/coverage-shape`], {
      ...entry,
      'rv:completeness': ['full'],
    }),
  ).toBe(false);
  expect(
    Value.Check(shapeSchemas[`${definition}release-v3/release-shape`], {
      ...release,
      'rv:releaseKind': ['formal'],
      'rv:releaseStatus': ['official'],
      'rv:coverageWork': ['urn:work:one'],
      'rv:definitionProfile': [`${definition}release-v3`],
      'rv:coverage': ['urn:release:coverage'],
    }),
  ).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}release-v3/revision-shape`], {
      ...revision,
      'rv:modelRevision': [`${definition}release-v3`],
      'rv:shapeRevision': [`${definition}release-v3`],
    }),
  ).toBe(true);
  expect(
    Value.Check(shapeSchemas[`${definition}release-v3/revision-shape`], {
      ...revision,
      'rv:modelRevision': [`${definition}release-v2`],
      'rv:shapeRevision': [`${definition}release-v3`],
    }),
  ).toBe(false);
});
