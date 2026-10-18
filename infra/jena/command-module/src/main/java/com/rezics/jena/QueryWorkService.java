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
    static final String READ_BUDGET_HEADER = "X-Rezics-Read-Budget-Ms";
    /** A transport cancellation and the caller's remaining wall allocation
     * cover parse, readiness, engine execution and lazy response consumption. */
    static final class ReadBoundary implements AutoCloseable {
        private static final ThreadLocal<ReadBoundary> CURRENT = new ThreadLocal<>();
        private static final java.util.concurrent.ScheduledThreadPoolExecutor TIMER = timer();
        private static java.util.concurrent.ScheduledThreadPoolExecutor timer() {
            var timer = new java.util.concurrent.ScheduledThreadPoolExecutor(1, work -> {
                Thread thread = new Thread(work, "native-read-deadline"); thread.setDaemon(true); return thread;
            });
            timer.setRemoveOnCancelPolicy(true);
            return timer;
        }
        private final Thread worker = Thread.currentThread();
        private final boolean wasInterrupted = worker.isInterrupted();
        private final long deadline;
        private final java.util.concurrent.ScheduledFuture<?> expiry;
        private Runnable execution;
        private boolean closed;
        private String reason;

        ReadBoundary(int milliseconds) {
            deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(milliseconds);
            expiry = TIMER.schedule(() -> cancel("deadline"), milliseconds, java.util.concurrent.TimeUnit.MILLISECONDS);
        }
        synchronized void cancel(String why) {
            if (closed || reason != null) return;
            reason = why;
            worker.interrupt();
            if (execution != null) execution.run();
        }
        private synchronized void watch(Runnable abort) {
            check(); execution = abort;
        }
        static void watch(QueryExec execution) {
            ReadBoundary current = CURRENT.get();
            if (current != null) current.watch(execution::abort);
        }
        static void watch(org.apache.jena.query.QueryExecution execution) {
            ReadBoundary current = CURRENT.get();
            if (current != null) current.watch(execution::abort);
        }
        static long deadline(long fallback) {
            ReadBoundary current = CURRENT.get();
            checkCurrent();
            return current == null ? fallback : Math.min(fallback, current.deadline);
        }
        private synchronized void check() {
            if (reason == null && System.nanoTime() >= deadline) cancel("deadline");
            if (reason != null) throw new org.apache.jena.query.QueryCancelledException("Native read " + reason);
        }
        static void checkCurrent() {
            ReadBoundary current = CURRENT.get();
            if (current != null) current.check();
        }
        @Override public synchronized void close() {
            closed = true; execution = null; expiry.cancel(false);
            // The servlet executor reuses this thread for unrelated requests.
            if (reason != null && !wasInterrupted) Thread.interrupted();
        }
    }

    static final class ReadBoundaryFilter implements jakarta.servlet.Filter {
        @Override public void doFilter(jakarta.servlet.ServletRequest request, jakarta.servlet.ServletResponse response,
                jakarta.servlet.FilterChain chain) throws java.io.IOException, jakarta.servlet.ServletException {
            var http = (jakarta.servlet.http.HttpServletRequest) request;
            String header = http.getHeader(READ_BUDGET_HEADER);
            if (header == null) { chain.doFilter(request, response); return; }
            if (!header.matches("[1-9][0-9]{0,4}") || Integer.parseInt(header) > 10_000) {
                ((jakarta.servlet.http.HttpServletResponse) response).sendError(400, "Invalid native read allocation"); return;
            }
            ReadBoundary previous = ReadBoundary.CURRENT.get();
            try (var boundary = new ReadBoundary(Integer.parseInt(header))) {
                ReadBoundary.CURRENT.set(boundary);
                var transport = org.eclipse.jetty.ee11.servlet.ServletContextRequest.getServletContextRequest(request);
                transport.addFailureListener(failure -> boundary.cancel("client-cancelled"));
                try { boundary.check(); chain.doFilter(request, response); }
                finally {
                    if (boundary.reason != null && !response.isCommitted())
                        ((jakarta.servlet.http.HttpServletResponse) response).setHeader("X-Rezics-Read-Reason", boundary.reason);
                }
            } finally {
                if (previous == null) ReadBoundary.CURRENT.remove(); else ReadBoundary.CURRENT.set(previous);
            }
        }
    }
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
            ReadBoundary.checkCurrent();
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
                ReadBoundary.checkCurrent();
                action.beginRead(); began[0] = true;
            })) {
                ReadBoundary.checkCurrent();
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

    @Override protected QueryExec createQueryExec(HttpAction action, Query query,
            org.apache.jena.sparql.core.DatasetGraph dataset) {
        ReadBoundary.checkCurrent();
        QueryExec execution = super.createQueryExec(action, query, dataset);
        try { ReadBoundary.watch(execution); return execution; }
        catch (RuntimeException failure) { execution.close(); throw failure; }
    }

    @Override protected QueryExecResult executeQuery(HttpAction action, QueryExec queryExec,
            Query requestQuery, String queryStringLog) {
        ReadBoundary.checkCurrent();
        QueryExecResult result = super.executeQuery(action, queryExec, requestQuery, queryStringLog);
        // Jena forces the first SELECT row here. Native reads return one complete
        // page/recipe envelope, so its visits are known before sendResults writes.
        action.getResponse().setHeader("X-Rezics-Command-Work", CommandWork.currentCounters());
        return result;
    }
}
