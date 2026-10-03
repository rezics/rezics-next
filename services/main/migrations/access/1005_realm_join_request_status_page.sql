-- Own-request history is an unbounded collection independent of pending inbox
-- membership. Seek the exact Realm/Agent history before joining unique basis
-- and decision rows; never scan another requester's history to fill a page.
CREATE INDEX realm_join_request_own_page ON access.realm_join_request(realm,member,id);
