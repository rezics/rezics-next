package com.rezics.jena;

import org.apache.jena.fuseki.servlets.HttpAction;
import org.apache.jena.fuseki.servlets.SPARQL_QueryDataset;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.QueryParseException;
import org.apache.jena.query.Syntax;
import org.apache.jena.fuseki.servlets.ServletOps;
import org.apache.jena.sparql.exec.QueryExec;
import org.apache.jena.sparql.exec.QueryExecResult;

/** Native reads use the same request-local work owner as commands. */
final class QueryWorkService extends SPARQL_QueryDataset {
    @Override protected void execute(String queryString, HttpAction action) {
        try (CommandWork work = new CommandWork()) {
            var data = action.getDataService().getDataset();
            if (SearchDeltaJournal.lucene(data) == null) {
                super.execute(queryString, action); return;
            }
            Query query;
            try {
                query = QueryFactory.create(queryString, org.apache.jena.fuseki.Fuseki.BaseParserSPARQL, Syntax.syntaxARQ);
                validateQuery(action, query);
            } catch (QueryParseException invalid) {
                ServletOps.errorBadRequest("Query parse error"); return;
            }
            // Jena's normal execution opens RDF before choosing the dataset. A
            // text request must open RDF and Lucene together, then keep both
            // through sendResults (which may consume lazy SELECT rows).
            boolean[] began = {false};
            try (var capture = SearchDeltaJournal.captureRead(data, () -> {
                action.beginRead(); began[0] = true;
            })) {
                var selected = decideDataset(action, query, "native captured query");
                Query effective = selected.getRight() == null ? query : selected.getRight();
                try (QueryExec queryExec = createQueryExec(action, effective, selected.getLeft())) {
                    QueryExecResult result = executeQuery(action, queryExec, query, "native captured query");
                    sendResults(action, result, query.getPrologue());
                }
            } catch (java.io.IOException unavailable) {
                ServletOps.errorOccurred("Committed text reader unavailable");
            } catch (QueryParseException invalid) {
                action.abortSilent();
                ServletOps.errorBadRequest("Query parse error");
            } catch (org.apache.jena.query.QueryCancelledException cancelled) {
                action.abortSilent();
                org.apache.jena.fuseki.servlets.ActionExecLib.incCounter(action.getEndpoint().getCounters(),
                    org.apache.jena.fuseki.server.CounterName.QueryTimeouts);
                throw cancelled;
            } finally { if (began[0]) action.endRead(); }
        }
    }

    @Override protected QueryExecResult executeQuery(HttpAction action, QueryExec queryExec,
            Query requestQuery, String queryStringLog) {
        QueryExecResult result = super.executeQuery(action, queryExec, requestQuery, queryStringLog);
        // Jena forces the first SELECT row here. Native reads return one complete
        // page/recipe envelope, so its visits are known before sendResults writes.
        action.getResponse().setHeader("X-Rezics-Command-Work", CommandWork.currentCounters());
        return result;
    }
}
