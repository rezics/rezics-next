-- A publication, classification edit or removal addresses one reply. Read-order
-- indexes begin with sort/population and otherwise scan the Realm on each trigger.
-- https://www.postgresql.org/docs/18/indexes-multicolumn.html
CREATE INDEX realm_thread_order_reply ON access.realm_thread_order(data_epoch,realm,reply);
CREATE INDEX realm_thread_private_order_reply ON access.realm_thread_private_order(data_epoch,realm,reply,sort,period,concept);

-- Root activity/reply aggregates do not change any ranking key. Keep the
-- aggregate write from repeating the same five (up to 45 with boards) upserts.
CREATE OR REPLACE TRIGGER realm_thread_reference_changed AFTER INSERT OR UPDATE OF
  data_epoch,realm,reply,placement,parent,work,occurred_at,score,active,concepts,new_epoch,new_sequence
  ON access.realm_thread_reference FOR EACH ROW EXECUTE FUNCTION access.realm_thread_reference_changed();
