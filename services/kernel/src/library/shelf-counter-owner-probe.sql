WITH native_input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id)
SELECT EXISTS (SELECT FROM library.entry WHERE route = (SELECT route FROM native_input) AND account_id = (SELECT account_id FROM native_input) LIMIT 1) AS "hasEntries",
       EXISTS (SELECT FROM library.collection WHERE route = (SELECT route FROM native_input) AND curator_account_id = (SELECT account_id FROM native_input) LIMIT 1) AS "hasCollections",
       EXISTS (SELECT FROM library.progress_session WHERE state <> 'retired' AND route = (SELECT route FROM native_input) AND account_id = (SELECT account_id FROM native_input) LIMIT 1) AS "hasSessions";
