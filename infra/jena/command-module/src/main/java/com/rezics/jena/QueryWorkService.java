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
    static final String READ_DEADLINE_HEADER = "X-Rezics-Server-Deadline";

    /** Charge native dispatch time as well as execution. The Unix deadline is
     * the existing operation's cross-hop cap, never a fresh allocation. */
    static long readDeadline(int milliseconds, String forwarded, long began) {
        long deadline = began + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(milliseconds);
        if (forwarded != null && forwarded.matches("[0-9]{1,16}")) {
            long absolute = Long.parseLong(forwarded);
            if (absolute > 0 && absolute <= 9_007_199_254_740_991L) {
                long remaining = Math.min(milliseconds, absolute - System.currentTimeMillis());
                // Clamp expired values before conversion to keep arithmetic bounded.
                deadline = Math.min(deadline, System.nanoTime()
                    + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(Math.max(0, remaining)));
            }
        }
        return deadline;
    }
    /** Private, in-process observation of synchronous filter work, including
     * refused and unbudgeted requests. Jetty dispatch before this filter is
     * outside coverage: this owner has no acquisition queue (pending is zero).
     * Neither interrupt nor response settlement retires a worker; filter exit
     * after boundary cleanup does. No engine/lock/transaction release is implied. */
    record ReadWorkerMeter(long starts, long released, long active, long pending,
            Long lastStartAt, Long zeroSince) {}
    record ReadWorkerEvent(String kind, Long worker, String trace, long at,
            boolean complete, ReadWorkerMeter totals) {}
    record ReadWorkerStatus(boolean attached, boolean complete, long failures,
            long dropped, int pendingNotifications, Long detachedAt, ReadWorkerMeter totals) {}

    static final class ReadWorkerLifecycle {
        private static final int SUBSCRIBERS = 8, QUEUED = 64;
        private final java.util.Set<ReadWorkerObservation> subscribers = new java.util.HashSet<>();
        private boolean started;
        private long sequence;

        synchronized ReadWorkerObservation observe(java.util.function.Consumer<ReadWorkerEvent> sink) {
            java.util.Objects.requireNonNull(sink);
            if (subscribers.size() >= SUBSCRIBERS) throw new IllegalStateException("Native worker observer limit");
            var observation = new ReadWorkerObservation(this, sink, !started);
            subscribers.add(observation);
            observation.emit("snapshot", null, null, System.currentTimeMillis());
            return observation;
        }
        synchronized ReadWorkerFlight enter(jakarta.servlet.ServletRequest request) {
            started = true;
            if (subscribers.isEmpty()) return null;
            var selected = subscribers.stream().filter(subscriber -> subscriber.detachedAt == null).toList();
            if (selected.isEmpty()) return null;
            // Reuse the existing W3C propagation identity, never a new diagnostic
            // header or authority. Keep only a validated trace id, not headers.
            String trace = null;
            try {
                String parent = ((jakarta.servlet.http.HttpServletRequest) request).getHeader("traceparent");
                if (parent != null && parent.matches("00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}")
                        && !parent.substring(3, 35).equals("0".repeat(32))
                        && !parent.substring(36, 52).equals("0".repeat(16))) trace = parent.substring(3, 35);
            } catch (Throwable failure) {
                for (var subscriber : selected) { subscriber.failures++; subscriber.complete = false; }
            }
            long at = System.currentTimeMillis(), worker = ++sequence;
            for (var subscriber : selected) {
                subscriber.starts++; subscriber.active++; subscriber.lastStartAt = at; subscriber.zeroSince = null;
                subscriber.emit("started", worker, trace, at);
            }
            return new ReadWorkerFlight(this, selected, worker, trace);
        }
        synchronized void release(ReadWorkerFlight flight) {
            if (flight.subscribers == null) return;
            long at = System.currentTimeMillis();
            for (var subscriber : flight.subscribers) {
                if (subscriber.detachedAt != null) continue;
                subscriber.active--; subscriber.released++;
                if (subscriber.active == 0) subscriber.zeroSince = at;
                subscriber.emit("released", flight.worker, flight.trace, at);
            }
            flight.subscribers = null; flight.trace = null;
        }
    }
    static final class ReadWorkerFlight implements AutoCloseable {
        private final ReadWorkerLifecycle owner;
        private java.util.List<ReadWorkerObservation> subscribers;
        private final long worker;
        private String trace;
        private ReadWorkerFlight(ReadWorkerLifecycle owner, java.util.List<ReadWorkerObservation> subscribers,
                long worker, String trace) {
            this.owner = owner; this.subscribers = subscribers; this.worker = worker; this.trace = trace;
        }
        @Override public void close() { owner.release(this); }
    }
    /** Attach before first native work/initial idle. Late attachment is sticky
     * incomplete. Delivery uses at most one daemon and 64 queued events per
     * subscriber; a blocking/failing sink cannot hold a native worker. Detached
     * slots remain reserved until drained, bounding even stuck private sinks.
     * After the full window: detach, bounded drain, inspect status, then verify
     * the consumer's separate bounded sink drain/count/bytes/hash/flush/close.
     * Missing events or incomplete/drop/failure status never establishes zero. */
    static final class ReadWorkerObservation {
        private final ReadWorkerLifecycle owner;
        private java.util.function.Consumer<ReadWorkerEvent> sink;
        private final java.util.concurrent.ThreadPoolExecutor delivery;
        private long starts, released, active, failures, dropped;
        private int notifications;
        private Long lastStartAt, zeroSince = System.currentTimeMillis(), detachedAt;
        private boolean complete;
        private ReadWorkerObservation(ReadWorkerLifecycle owner,
                java.util.function.Consumer<ReadWorkerEvent> sink, boolean complete) {
            this.owner = owner; this.sink = sink; this.complete = complete;
            delivery = new java.util.concurrent.ThreadPoolExecutor(1, 1, 0,
                java.util.concurrent.TimeUnit.MILLISECONDS, new java.util.concurrent.ArrayBlockingQueue<>(ReadWorkerLifecycle.QUEUED),
                work -> { var thread = new Thread(work, "native-worker-observer"); thread.setDaemon(true); return thread; });
        }
        private ReadWorkerMeter meter() { return new ReadWorkerMeter(starts, released, active, 0, lastStartAt, zeroSince); }
        private void emit(String kind, Long worker, String trace, long at) {
            var event = new ReadWorkerEvent(kind, worker, trace, at, complete, meter());
            notifications++;
            try {
                delivery.execute(() -> {
                    try { sink.accept(event); }
                    catch (Throwable failure) { synchronized (owner) { failures++; complete = false; } }
                    finally { synchronized (owner) { notifications--; } }
                });
            } catch (RuntimeException failure) { notifications--; dropped++; complete = false; }
        }
        ReadWorkerStatus status() {
            synchronized (owner) {
                return new ReadWorkerStatus(detachedAt == null, complete, failures, dropped,
                    notifications, detachedAt, meter());
            }
        }
        void detach() {
            synchronized (owner) {
                if (detachedAt != null) return;
                detachedAt = System.currentTimeMillis();
                if (active != 0) complete = false;
                delivery.shutdown();
            }
        }
        /** Wait at most one second; false means cleanup/coverage remains unknown.
         * This closes only source delivery, never the consumer's private sink. */
        boolean drain() throws InterruptedException {
            synchronized (owner) { if (detachedAt == null) throw new IllegalStateException("Detach before drain"); }
            if (!delivery.awaitTermination(1, java.util.concurrent.TimeUnit.SECONDS)) return false;
            synchronized (owner) { sink = null; owner.subscribers.remove(this); }
            return true;
        }
    }
    private static final ReadWorkerLifecycle READ_WORKERS = new ReadWorkerLifecycle();
    static ReadWorkerObservation observeReadWorkers(java.util.function.Consumer<ReadWorkerEvent> sink) {
        return READ_WORKERS.observe(sink);
    }
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
        private final ReadBoundary parent = CURRENT.get();
        private final boolean wasInterrupted = worker.isInterrupted();
        private final long deadline;
        private final java.util.concurrent.ScheduledFuture<?> expiry;
        private org.eclipse.jetty.server.internal.HttpConnection connection;
        private java.util.concurrent.ScheduledFuture<?> disconnect;
        private final java.nio.ByteBuffer transportInput = java.nio.ByteBuffer.allocate(1).limit(0);
        private Runnable execution;
        private boolean closed;
        private String reason;

        ReadBoundary(int milliseconds) {
            this(System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(milliseconds));
        }
        ReadBoundary(long requestedDeadline) {
            deadline = parent == null ? requestedDeadline : Math.min(requestedDeadline, parent.deadline);
            expiry = TIMER.schedule(() -> cancel("deadline"), Math.max(0, deadline - System.nanoTime()),
                java.util.concurrent.TimeUnit.NANOSECONDS);
        }
        synchronized void cancel(String why) {
            if (closed || reason != null) return;
            reason = why;
            if (disconnect != null) disconnect.cancel(false);
            worker.interrupt();
            if (execution != null) execution.run();
        }
        private synchronized void monitorTransport() {
            if (connection == null || disconnect != null || closed || reason != null) return;
            // A synchronous HTTP/1 handler has no socket read pending after its
            // body is consumed. Jetty's failure listener alone cannot observe a
            // disconnect while that handler waits for publication or an engine.
            disconnect = TIMER.scheduleWithFixedDelay(this::probeTransport, 0, 10,
                java.util.concurrent.TimeUnit.MILLISECONDS);
        }
        private synchronized void probeTransport() {
            if (closed || reason != null) return;
            // Only the operation's body-complete execution/capture path arms
            // this probe. Leave any bytes already owned by Jetty untouched.
            if (!connection.getEndPoint().isOpen()) { cancel("client-cancelled"); return; }
            if (!connection.getParser().isComplete() || !connection.isRequestBufferEmpty()) return;
            try {
                int filled = connection.getEndPoint().fill(transportInput);
                if (filled < 0) cancel("client-cancelled");
                else if (filled > 0) {
                    // A pipelined request is not a cancellation. Return its
                    // byte to Jetty's existing input buffer before completion.
                    connection.onUpgradeTo(transportInput);
                    disconnect.cancel(false);
                }
            } catch (java.io.IOException failure) { cancel("client-cancelled"); }
        }
        private synchronized void watch(Runnable abort) {
            check(); execution = abort; monitorTransport();
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
            if (parent != null) parent.check();
            if (reason == null && System.nanoTime() >= deadline) cancel("deadline");
            if (reason != null) throw new org.apache.jena.query.QueryCancelledException(
                new java.util.concurrent.CancellationException("Native read " + reason));
        }
        static void checkCurrent() {
            ReadBoundary current = CURRENT.get();
            if (current != null) current.check();
        }
        /** A capture can wait before an engine exists to watch. Use the same
         * deadline and interrupt that cancel that engine, including while a
         * publisher is still inside its atomic RDF/Lucene fence. */
        static void lockForRead(java.util.concurrent.locks.ReentrantLock lock) {
            ReadBoundary current = CURRENT.get();
            checkCurrent();
            if (current != null) current.monitorTransport();
            try {
                if (current == null) lock.lockInterruptibly();
                else if (!lock.tryLock(Math.max(0, current.deadline - System.nanoTime()),
                        java.util.concurrent.TimeUnit.NANOSECONDS)) {
                    current.cancel("deadline");
                    current.check();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                checkCurrent();
                throw new org.apache.jena.query.QueryCancelledException(interrupted);
            }
            try { checkCurrent(); }
            catch (RuntimeException cancelled) { lock.unlock(); throw cancelled; }
        }
        @Override public synchronized void close() {
            closed = true; execution = null; expiry.cancel(false);
            if (disconnect != null) disconnect.cancel(false);
            // The servlet executor reuses this thread for unrelated requests.
            if (reason != null && !wasInterrupted) Thread.interrupted();
        }
    }

    static final class ReadBoundaryFilter implements jakarta.servlet.Filter {
        private final ReadWorkerLifecycle workers;
        ReadBoundaryFilter() { this(READ_WORKERS); }
        ReadBoundaryFilter(ReadWorkerLifecycle workers) { this.workers = workers; }
        @Override public void doFilter(jakarta.servlet.ServletRequest request, jakarta.servlet.ServletResponse response,
                jakarta.servlet.FilterChain chain) throws java.io.IOException, jakarta.servlet.ServletException {
            try (var worker = workers.enter(request)) { filterRead(request, response, chain); }
        }
        private void filterRead(jakarta.servlet.ServletRequest request, jakarta.servlet.ServletResponse response,
                jakarta.servlet.FilterChain chain) throws java.io.IOException, jakarta.servlet.ServletException {
            var http = (jakarta.servlet.http.HttpServletRequest) request;
            String header = http.getHeader(READ_BUDGET_HEADER);
            if (header == null) { chain.doFilter(request, response); return; }
            if (!header.matches("[1-9][0-9]{0,4}") || Integer.parseInt(header) > 10_000) {
                ((jakarta.servlet.http.HttpServletResponse) response).sendError(400, "Invalid native read allocation"); return;
            }
            var transport = org.eclipse.jetty.ee11.servlet.ServletContextRequest.getServletContextRequest(request);
            long deadline = readDeadline(Integer.parseInt(header), http.getHeader(READ_DEADLINE_HEADER),
                transport.getBeginNanoTime());
            ReadBoundary previous = ReadBoundary.CURRENT.get();
            try (var boundary = new ReadBoundary(deadline)) {
                ReadBoundary.CURRENT.set(boundary);
                if (transport.getConnectionMetaData().getConnection()
                        instanceof org.eclipse.jetty.server.internal.HttpConnection connection)
                    boundary.connection = connection;
                transport.addFailureListener(failure -> boundary.cancel("client-cancelled"));
                try {
                    // Start disconnect coverage before parsing/transaction admission;
                    // the probe touches the socket only once Jetty owns no body bytes.
                    boundary.monitorTransport();
                    if (boundary.connection != null) boundary.probeTransport();
                    boundary.check(); chain.doFilter(request, response);
                }
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
                SearchDeltaJournal.invalidateRead(data, "committed reader unavailable", "query");
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
