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
    static final String READ_CUT_HEADER = "X-Rezics-Read-Cut";
    static final String GRAPH_VERSION_HEADER = "X-Rezics-Graph-Version";
    static final String REQUIRE_QUALIFIED_HEADER = "X-Rezics-Require-Qualified-Read";
    static final int MAX_READ_CUT_BYTES = 2048;

    /** Evidence is bounded even if a damaged control graph contains oversized IRIs. */
    static org.apache.jena.atlas.json.JsonObject readCutHeader(java.util.Map<String, Object> evidence) {
        if (Boolean.TRUE.equals(evidence.get("qualified"))
            && !evidence.keySet().containsAll(java.util.List.of("dataEpoch", "sequence", "generation",
                "luceneGeneration", "ordinal", "writeEpoch")))
            return unavailableHeader("cut-evidence-unavailable", Boolean.TRUE.equals(evidence.get("textIndexUncertain")));
        var header = new org.apache.jena.atlas.json.JsonObject();
        for (var entry : evidence.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof Boolean flag) header.put(entry.getKey(), flag);
            else if (value instanceof Integer number) header.put(entry.getKey(), number);
            else if (value instanceof String string && string.length() <= 256
                && string.chars().allMatch(character -> character >= 32 && character <= 126))
                header.put(entry.getKey(), string);
            else return unavailableHeader("cut-evidence-unavailable", Boolean.TRUE.equals(evidence.get("textIndexUncertain")));
        }
        return org.apache.jena.atlas.json.JSON.toStringFlat(header).length() <= MAX_READ_CUT_BYTES ? header
            : unavailableHeader("cut-evidence-unavailable", Boolean.TRUE.equals(evidence.get("textIndexUncertain")));
    }

    private static org.apache.jena.atlas.json.JsonObject unavailableHeader(String reason) {
        return unavailableHeader(reason, false);
    }
    private static org.apache.jena.atlas.json.JsonObject unavailableHeader(String reason, boolean uncertain) {
        var header = new org.apache.jena.atlas.json.JsonObject();
        header.put("version", 1); header.put("qualified", false);
        header.put("textIndexUncertain", uncertain);
        header.put("reason", reason);
        return header;
    }

    private static void unavailable(HttpAction action) throws java.io.IOException {
        action.getResponse().setStatus(503);
        action.getResponse().setContentType("application/json; charset=utf-8");
        var payload = new org.apache.jena.atlas.json.JsonObject();
        payload.put("status", "unavailable");
        org.apache.jena.atlas.json.JSON.write(action.getResponse().getOutputStream(), payload);
    }

    @Override protected void execute(String queryString, HttpAction action) {
        try (CommandWork work = new CommandWork()) {
            String require = action.getRequest().getHeader(REQUIRE_QUALIFIED_HEADER);
            if (require != null && !require.equalsIgnoreCase("true") && !require.equalsIgnoreCase("false")) {
                ServletOps.errorBadRequest("Qualified read header must be true or false"); return;
            }
            boolean requireQualified = "true".equalsIgnoreCase(require);
            var data = action.getDataService().getDataset();
            if (SearchDeltaJournal.lucene(data) == null) {
                action.getResponse().setHeader(READ_CUT_HEADER, org.apache.jena.atlas.json.JSON.toStringFlat(unavailableHeader("text-index-unavailable")));
                if (requireQualified) {
                    try { unavailable(action); }
                    catch (java.io.IOException failure) { throw new java.io.UncheckedIOException(failure); }
                    return;
                }
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
                String graphVersion = TemplateIndexService.graphReadVersion(data);
                if (graphVersion != null) action.getResponse().setHeader(GRAPH_VERSION_HEADER, graphVersion);
                var evidence = readCutHeader(capture.evidence());
                action.getResponse().setHeader(READ_CUT_HEADER, org.apache.jena.atlas.json.JSON.toStringFlat(evidence));
                if (requireQualified && !evidence.get("qualified").getAsBoolean().value()) {
                    unavailable(action); return;
                }
                var selected = decideDataset(action, query, "native captured query");
                Query effective = selected.getRight() == null ? query : selected.getRight();
                try (QueryExec queryExec = createQueryExec(action, effective, selected.getLeft())) {
                    QueryExecResult result = executeQuery(action, queryExec, query, "native captured query");
                    sendResults(action, result, query.getPrologue());
                }
            } catch (java.io.IOException unavailable) {
                SearchDeltaJournal.invalidate(data, "committed reader unavailable", "query");
                if (requireQualified && !action.getResponse().isCommitted()) {
                    action.getResponse().setHeader(READ_CUT_HEADER, org.apache.jena.atlas.json.JSON.toStringFlat(
                        unavailableHeader("committed-reader-unavailable", SearchDeltaJournal.textIndexUncertain(data))));
                    try { unavailable(action); }
                    catch (java.io.IOException failure) { throw new java.io.UncheckedIOException(failure); }
                    return;
                }
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
