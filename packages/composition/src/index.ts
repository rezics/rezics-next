// SPDX-License-Identifier: Apache-2.0
export type {
  CompositionComponent,
  CompositionDocument,
  CompositionNode,
  CompositionRegistry,
  CompositionViolation,
  CompositionViolationCode,
  ComponentDefinition,
  PageContext,
  PageFilter,
  PageRead,
} from './registry.ts';
export {
  APPEARANCE,
  MAX_COMPOSITION_BYTES,
  MAX_COMPOSITION_DEPTH,
  MAX_COMPOSITION_NODES,
  SLOT_NAMES,
  defineRegistry,
  platformRegistry,
} from './registry.ts';
export { curie, href, localeChain, localizedText, pickLanguage, pickText, plainText } from './strings.ts';
export { compositionSchema } from './schema.ts';
export { validateComposition } from './validate.ts';
export { MAX_ZONE_PAGES, MAX_ZONE_SCOPE, UI_LOCALES, validateZoneStarter, type ZoneStarter } from './zone.ts';
export { MAX_PAGE_COST, MAX_PAGE_READS, planReads, readCost, shownProperties, type PageReadPlan } from './reads.ts';
export type {
  PresentationProfile,
  ProfileBaseTemplate,
  ProfileRouteTemplate,
  ProfileTypeTemplate,
  ResolvedTemplate,
  TemplateTarget,
} from './profile.ts';
export {
  MAX_PROFILE_BYTES,
  MAX_PROFILE_TEMPLATES,
  PROFILE_FORMAT,
  PROFILE_ROUTE_MAX_LENGTH,
  PROFILE_ROUTE_PATTERN,
  profileDigest,
  resolveTemplate,
  validateProfile,
} from './profile.ts';
