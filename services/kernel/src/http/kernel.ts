import { contentViewerActionResources } from '../content/viewer-actions.ts';
import { readCommerceMoneyPolicy, type CommerceMoneyPolicy } from '../commerce/money.ts';
import { mountContentEditionConsent } from '../content/edition-sale.ts';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import { createContentEditionBuyerFactReader } from '../commerce/content-edition-buyer-fact.ts';
import { MAX_CONSENTED_SCOPES } from '@rezics/auth-contract';
import { NATIVE_CONTAINER_ACTIONS } from '../community/actions.ts';
import { assertReceiptKeyRing, configureReceiptKeys, readReceiptKeyRing } from '../command/receipt-key.ts';
import { randomBytes } from 'node:crypto';
import { zoneRoutes } from '../zones/http.ts';
import { zoneViewerActionResource } from '../zones/viewer-actions.ts';
import type { Elysia } from 'elysia';
import { parseExposure } from '../access/gates/declaration.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { accessActionCatalogue, assertInternalActionDeclarations, createAccess } from '../access/index.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { assertDeclaredResourceTypes } from '../access/resource-roles.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import {
  compileViewerActionBindings,
  viewerActionBindingActions,
  viewerActionsRoutes,
  type ViewerActionResources,
  type ViewerActionBindings,
} from '../access/viewer-actions.ts';
import { contextViewerActionResource, subjectViewerActionResources } from '../semantic/viewer-actions.ts';
import { accountViewerActionResource } from '../access/account-viewer-actions.ts';
import { collectionViewerActionResource } from '../library/collection-reads.ts';
import { realmViewerActionResource } from '../community/realm.ts';
import { spaceViewerActionResource } from '../community/space.ts';
import { accessRoutes } from '../access/routes.ts';
import { erasureStatusRoutes } from '../access/erasure-status-route.ts';
import { exposureRoutes } from '../access/gates/routes.ts';
import { createRealmMembership } from '../community/membership.ts';
import { createRealmParticipationCheck, type RealmParticipationCheck } from '../community/participation.ts';
import { realmReadEligibility } from '../community/realm.ts';
import { communityRoutes } from '../community/routes.ts';
import { systemClock } from '../clock.ts';
import { payoutRoutes } from '../commerce/payout-routes.ts';
import { commerceRoutes, type CommerceDependencies } from '../commerce/routes.ts';
import { collectionRoutes } from '../library/collection-routes.ts';
import { continueRoutes } from '../library/continue-routes.ts';
import { feedRoutes } from '../content/feed-routes.ts';
import { personalLabelRoutes } from '../library/label-routes.ts';
import { pinRoutes } from '../library/pin-routes.ts';
import { progressRoutes } from '../library/progress-routes.ts';
import { ratingRoutes } from '../rating/routes.ts';
import { sourceStatisticRoutes } from '../rating/source-statistics.ts';
import type { ContentBoardDependencies } from '../content/boards.ts';
import { currentRealmDisclosureScope } from '../content/reads.ts';
import { mediaRoutes } from '../content/media-routes.ts';
import { contentRoutes, subjectReactionRoutes } from '../content/routes.ts';
import { noticeRoutes } from '../content/notice-routes.ts';
import { realmOfItem } from '../content/realm-of-item.ts';
import type { TurnstileVerifier } from '../content/turnstile.ts';
import type { ContentRuntime } from '../content/runtime.ts';
import { bangumiImportRoutes } from '../library/list-import-bangumi-routes.ts';
import { malImportRoutes } from '../library/list-import-mal-routes.ts';
import { libraryExportRoutes } from '../library/library-export-routes.ts';
import { copyArchiveRoutes } from '../library/copy-archive-routes.ts';
import { personalLibraryRoutes } from '../library/personal-routes.ts';
