import { defineOperationDescriptors } from './catalogue.ts';

export const LIBRARY_OPERATION_DECLARATIONS = defineOperationDescriptors([
  {
    operationId: 'progress_session.record',
    method: 'POST',
    path: '/v1/progressSessions/:sessionId/$record',
    action: 'progress_session:update',
    audience: 'account',
    security: [{ scheme: 'bearerAuth' }],
    exposure: 'gate:reading_progress',
    resourceTypes: [],
    rateLimit: 'kernel.write.single',
    contracts: {
      params: 'library.progress-session.record.params',
      headers: 'library.idempotency.headers',
      body: 'library.progress-session.record.request',
      response: 'library.progress-session.write.response',
    },
  },
  {
    operationId: 'library_continue.list',
    method: 'GET',
    path: '/v1/libraryContinue',
    action: 'library_entry:list',
    audience: 'account',
    security: [{ scheme: 'bearerAuth' }],
    exposure: 'gate:personal_library',
    resourceTypes: [],
    contracts: {
      query: 'library.continue.query',
      response: 'library.continue.page',
    },
  },
]);

export const FEED_OPERATION_DECLARATIONS = defineOperationDescriptors([
  {
    operationId: 'feed_item.list',
    method: 'GET',
    path: '/v1/feedItems',
    action: 'feed_item:list',
    audience: 'public',
    security: [{ scheme: 'anonymous' }, { scheme: 'bearerAuth' }],
    exposure: 'public',
    resourceTypes: [],
    contracts: {
      query: 'content.feed.items.query',
      response: 'content.feed.page',
    },
  },
]);
