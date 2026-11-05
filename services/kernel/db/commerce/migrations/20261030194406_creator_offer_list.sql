-- migrate:up
CREATE INDEX offer_creator_page ON commerce.offer (route, creator_account_id, offer_id);

-- migrate:down
DROP INDEX commerce.offer_creator_page;
