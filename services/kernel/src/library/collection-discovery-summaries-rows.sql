-- Full routed keys only: this is an input-bounded hydration probe, never catalogue discovery.
SELECT c.collection_id::text AS id, c.route, c.title, c.description, c.visibility, c.state,
       c.membership_kind AS "membershipKind", c.revision, c.member_count AS "memberCount",
       c.order_epoch AS "orderEpoch", c.source_generation::text AS "sourceGeneration",
       c.presentation_kind AS "presentationKind", c.cover_media_id::text AS "coverMediaId",
       c.created_at::text AS "createdAt", c.updated_at::text AS "updatedAt",
       c.curator_account_id IS NULL AS deidentified,
       a.state AS "ownerState", a.minimum_authn_epoch::text AS "ownerEpoch"
FROM unnest(:routes::integer[], :ids::uuid[]) AS requested(route, id)
JOIN library.collection c ON c.route = requested.route AND c.collection_id = requested.id
LEFT JOIN access.account a ON a.route = c.route AND a.account_id = c.curator_account_id;
