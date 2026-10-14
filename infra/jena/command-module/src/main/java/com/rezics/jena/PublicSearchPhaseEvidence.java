package com.rezics.jena;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import java.io.PrintWriter;
import java.io.OutputStreamWriter;
import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicReferenceArray;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import java.util.function.IntSupplier;
import java.util.function.Supplier;

/** Observations only: readiness, deadlines and cancellation retain their existing owners.
 * Durations overlap, so nested phases must never be summed as disjoint work. */
final class PublicSearchPhaseEvidence implements Filter {
    enum Phase { REQUEST, QUERY, READER_OPEN, PARSE, ANALYZER_QUERY, RANK, WITNESS, PROOF, TEXT_PREPARE,
        TEXT_COMMIT, QUALIFICATION, AUDIT, RECOVERY, OCCURRENCE_DISCOVERY, OCCURRENCE_PROJECT, MERGE, COMMAND }
    private record Running(Phase phase, long started) {}
    private record View(Running active, Map<Phase, Long> durations, long omitted) {}
    private static long cpu() {
        var bean = ManagementFactory.getThreadMXBean();
        return bean.isCurrentThreadCpuTimeSupported() && bean.isThreadCpuTimeEnabled()
            ? bean.getCurrentThreadCpuTime() : -1;
    }
    private record MergeObservation(int threads, long sampledAt) {}
    private static final ThreadLocal<Request> CURRENT = new ThreadLocal<>();
    private static final ThreadLocal<Scope> SEQUENTIAL = new ThreadLocal<>();
    private static final ThreadLocal<Boolean> UNTRACKED_REQUEST = new ThreadLocal<>();
    private static final AtomicReference<PublicSearchPhaseEvidence> OWNER = new AtomicReference<>();
    private final AtomicReferenceArray<Request> requests = new AtomicReferenceArray<>(128);
    private final AtomicReferenceArray<Running> background = new AtomicReferenceArray<>(8);
    private final AtomicReference<MergeObservation> merge = new AtomicReference<>(new MergeObservation(0, 0));
    private final AtomicLong saturated = new AtomicLong();
    private final AtomicLong backgroundSaturated = new AtomicLong();
    private final AtomicLong suppressed = new AtomicLong();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final LongSupplier clock;
    private final Consumer<String> events;
    private final IntSupplier mergeThreads;
    private final ScheduledExecutorService watchdog;
    private final ScheduledExecutorService sampler;
    private final AtomicReference<Bucket> bucket;
    private final AtomicLong nextSummary;
    private record Bucket(int tokens, long refilledAt) {}

    PublicSearchPhaseEvidence() {
        this(System::nanoTime, event -> org.slf4j.LoggerFactory.getLogger(PublicSearchPhaseEvidence.class).warn(event), true);
    }
    PublicSearchPhaseEvidence(LongSupplier clock, Consumer<String> events, boolean observers) {
        this(clock, events, observers, FilteredGraphTextIndex::mergeThreadCount);
    }
    PublicSearchPhaseEvidence(LongSupplier clock, Consumer<String> events, boolean observers, IntSupplier mergeThreads) {
        this.clock = clock;
        this.events = events;
        this.mergeThreads = mergeThreads;
        long now = clock.getAsLong();
        bucket = new AtomicReference<>(new Bucket(8, now));
        nextSummary = new AtomicLong(now + TimeUnit.MINUTES.toNanos(1));
        watchdog = observers ? observer("public-search-deadline") : null;
        sampler = observers ? observer("public-search-merge-sampler") : null;
        if (observers) {
            watchdog.scheduleAtFixedRate(this::scanSafely, 10, 10, TimeUnit.MILLISECONDS);
            sampler.scheduleWithFixedDelay(this::sampleMerge, 0, 1, TimeUnit.SECONDS);
        }
    }
    private static ScheduledExecutorService observer(String name) {
        return Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, name);
            thread.setDaemon(true);
            return thread;
        });
    }
    void install() { OWNER.set(this); }

    @Override public void doFilter(ServletRequest servlet, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        if (!(servlet instanceof HttpServletRequest http) || closed.get()) {
            chain.doFilter(servlet, response); return;
        }
        String header = http.getHeader("x-rezics-search-budget-ms");
        String trace = http.getHeader("traceparent");
        Phase entryPhase = "occurrence-discovery".equals(http.getHeader("x-rezics-native-phase"))
            ? Phase.OCCURRENCE_DISCOVERY : Phase.REQUEST;
        if (header == null || !header.matches("[1-9][0-9]{0,3}") || Integer.parseInt(header) > 1500
                || (trace != null && !validTrace(trace))) {
            // Only a fixed caller label can identify plain-SPARQL maintenance; never infer its job from the body.
            try (Scope ignored = phase(entryPhase)) { chain.doFilter(servlet, response); }
            return;
        }
        long now = clock.getAsLong();
        Request request = new Request(now, now + TimeUnit.MILLISECONDS.toNanos(Integer.parseInt(header)), trace, entryPhase);
        int slot = -1;
        for (int i = 0; i < requests.length(); i++) {
            if (requests.compareAndSet(i, null, request)) { slot = i; break; }
        }
        if (closed.get()) {
            if (slot >= 0) requests.compareAndSet(slot, request, null);
            chain.doFilter(servlet, response); return;
        }
        if (slot < 0) {
            saturated.incrementAndGet();
            Boolean previousUntracked = UNTRACKED_REQUEST.get();
            UNTRACKED_REQUEST.set(true);
            try { chain.doFilter(servlet, response); }
            finally {
                if (previousUntracked == null) UNTRACKED_REQUEST.remove();
                else UNTRACKED_REQUEST.set(previousUntracked);
            }
            return;
        }
        request.capture = "1".equals(http.getHeader("x-rezics-search-evidence")) && trace != null;
        request.cpuStarted = request.capture ? cpu() : -1;
        Request previous = CURRENT.get();
        Scope previousSequential = SEQUENTIAL.get();
        CURRENT.set(request);
        SEQUENTIAL.remove();
        try { chain.doFilter(servlet, request.capture && response instanceof HttpServletResponse httpResponse
            ? evidenceResponse(httpResponse, request) : response); }
        finally {
            expire(request, clock.getAsLong());
            endPhase();
            if (request.capture) emit(snapshot(request, "public_search_native_complete"));
            requests.compareAndSet(slot, request, null);
            if (previous == null) CURRENT.remove(); else CURRENT.set(previous);
            if (previousSequential != null) SEQUENTIAL.set(previousSequential);
        }
    }
    // Opt-in owning-operation captures carry no RDF values or query text. Ordinary
    // requests retain the existing bounded deadline observer and event bucket.
    static void work(String counter, long amount) {
        Request request = CURRENT.get();
        if (request != null && request.capture && request.work.size() < 24)
            request.work.merge(counter, amount, Long::sum);
    }
    static void checkpoint(Map<String, Object> cut) {
        Request request = CURRENT.get();
        if (request != null && request.capture) for (String key : List.of("dataEpoch", "sequence",
                "generation", "luceneGeneration", "qualified", "textIndexUncertain", "ordinal", "writeEpoch"))
            if (cut.containsKey(key)) request.checkpoint.put(key, cut.get(key));
    }
    private HttpServletResponse evidenceResponse(HttpServletResponse response, Request request) {
        return new HttpServletResponseWrapper(response) {
            private boolean observed;
            private ServletOutputStream stream;
            private PrintWriter writer;
            private void beforeWrite() {
                if (observed) return;
                observed = true;
                String evidence = snapshot(request, "public_search_native_first_write");
                if (evidence.length() <= 2048) setHeader("X-Rezics-Search-Evidence", evidence);
            }
            @Override public ServletOutputStream getOutputStream() throws IOException {
                if (stream == null) {
                    ServletOutputStream target = super.getOutputStream();
                    stream = new ServletOutputStream() {
                        @Override public boolean isReady() { return target.isReady(); }
                        @Override public void setWriteListener(WriteListener listener) { target.setWriteListener(listener); }
                        @Override public void write(int value) throws IOException { beforeWrite(); target.write(value); }
                        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                            beforeWrite(); target.write(bytes, offset, length);
                        }
                        @Override public void flush() throws IOException { beforeWrite(); target.flush(); }
                        @Override public void close() throws IOException { beforeWrite(); target.close(); }
                    };
                }
                return stream;
            }
            @Override public PrintWriter getWriter() throws IOException {
                if (writer == null) writer = new PrintWriter(new OutputStreamWriter(getOutputStream(), getCharacterEncoding()));
                return writer;
            }
        };
    }
    private String snapshot(Request request, String name) {
        long ended = clock.getAsLong(), cpuEnded = cpu();
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("event", name);
        event.put("traceparent", request.trace);
        event.put("elapsedMs", (ended - request.started) / 1_000_000.0);
        event.put("threadCpuMs", request.cpuStarted < 0 || cpuEnded < request.cpuStarted ? -1
            : (cpuEnded - request.cpuStarted) / 1_000_000.0);
        Map<String, Double> phases = new LinkedHashMap<>(), phaseCpu = new LinkedHashMap<>();
        request.view.get().durations().forEach((key, value) -> phases.put(key.name(), value / 1_000_000.0));
        request.cpuNanos.forEach((key, value) -> phaseCpu.put(key.name(), value / 1_000_000.0));
        event.put("overlappingPhaseMs", phases);
        event.put("overlappingThreadCpuMs", phaseCpu);
        event.put("threadCpuNanos", request.cpuStarted < 0 || cpuEnded < request.cpuStarted ? -1 : cpuEnded - request.cpuStarted);
        event.put("work", request.work);
        event.put("checkpoint", request.checkpoint);
        return org.apache.jena.atlas.json.JSON.toStringFlat(CommandService.jsonObject(event));
    }
    private static boolean validTrace(String trace) {
        return trace.matches("00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}")
            && !trace.substring(3, 35).equals("0".repeat(32))
            && !trace.substring(36, 52).equals("0".repeat(16));
    }
    private static final class Request {
        final long started;
        final long deadline;
        final String trace;
        boolean capture;
        long cpuStarted;
        final Map<Phase, Long> cpuNanos = new LinkedHashMap<>();
        final Map<String, Long> work = new LinkedHashMap<>();
        final Map<String, Object> checkpoint = new LinkedHashMap<>();
        final AtomicBoolean emitted = new AtomicBoolean();
        final AtomicReference<View> view;
        Request(long started, long deadline, String trace, Phase entryPhase) {
            this.started = started; this.deadline = deadline; this.trace = trace;
            view = new AtomicReference<>(new View(new Running(entryPhase, started), Map.of(), 0));
        }
    }
    static final class Scope implements AutoCloseable {
        private final Runnable finish;
        private boolean finished;
        Scope(Runnable finish) { this.finish = finish; }
        @Override public void close() { if (!finished) { finished = true; finish.run(); } }
    }
    static Scope phase(Phase phase) {
        PublicSearchPhaseEvidence owner = OWNER.get();
        if (owner == null || owner.closed.get() || Boolean.TRUE.equals(UNTRACKED_REQUEST.get())) return new Scope(() -> {});
        long now = owner.clock.getAsLong();
        Running running = new Running(phase, now);
        Request request = CURRENT.get();
        if (request != null) {
            owner.expire(request, now);
            long cpuStarted = request.capture ? cpu() : -1;
            View previous = request.view.getAndUpdate(view -> new View(running, view.durations(), view.omitted()));
            return new Scope(() -> {
                owner.expire(request, owner.clock.getAsLong());
                long cpuEnded = request.capture ? cpu() : -1;
                if (cpuStarted >= 0 && cpuEnded >= cpuStarted)
                    request.cpuNanos.merge(phase, cpuEnded - cpuStarted, Long::sum);
                request.view.updateAndGet(view -> {
                Map<Phase, Long> durations = new LinkedHashMap<>(view.durations());
                long omitted = view.omitted();
                if (durations.containsKey(phase) || durations.size() < 8)
                    durations.merge(phase, Math.max(0, owner.clock.getAsLong() - now), Long::sum);
                else omitted++;
                return new View(previous.active(), Map.copyOf(durations), omitted);
                });
            });
        }
        for (int i = 0; i < owner.background.length(); i++) {
            if (owner.background.compareAndSet(i, null, running)) {
                int slot = i;
                if (owner.closed.get()) {
                    owner.background.compareAndSet(slot, running, null);
                    return new Scope(() -> {});
                }
                return new Scope(() -> owner.background.compareAndSet(slot, running, null));
            }
        }
        owner.backgroundSaturated.incrementAndGet();
        return new Scope(() -> {});
    }
    static <T> T timed(Phase phase, Supplier<T> work) {
        try (Scope ignored = phase(phase)) { return work.get(); }
    }
    static void timed(Phase phase, Runnable work) { timed(phase, () -> { work.run(); return null; }); }
    static void enter(Phase phase) { endPhase(); SEQUENTIAL.set(phase(phase)); }
    static void endPhase() {
        Scope scope = SEQUENTIAL.get();
        SEQUENTIAL.remove();
        if (scope != null) scope.close();
    }
    private void scanSafely() {
        try { scan(); } catch (RuntimeException ignored) { /* Evidence must not stop the observer or request. */ }
    }
    void scan() {
        if (closed.get()) return;
        long now = clock.getAsLong();
        for (int i = 0; i < requests.length(); i++) {
            Request request = requests.get(i);
            if (request != null) expire(request, now);
        }
        long summary = nextSummary.get();
        if (now >= summary && nextSummary.compareAndSet(summary, now + TimeUnit.MINUTES.toNanos(1))) {
            // Keep counts until the process bucket has room for their aggregate.
            if (suppressed.get() == 0 && saturated.get() == 0 && backgroundSaturated.get() == 0) return;
            if (!takeToken(now)) return;
            long dropped = suppressed.getAndSet(0);
            long full = saturated.getAndSet(0);
            long backgroundFull = backgroundSaturated.getAndSet(0);
            if (dropped + full + backgroundFull > 0)
                emit("{\"event\":\"public_search_phase_suppressed\",\"suppressed\":" + dropped
                    + ",\"saturated\":" + full + ",\"backgroundSaturated\":" + backgroundFull + "}");
        }
    }
    private boolean takeToken(long now) {
        while (true) {
            Bucket old = bucket.get();
            long refill = Math.max(0, (now - old.refilledAt()) / TimeUnit.SECONDS.toNanos(1));
            int available = (int) Math.min(8L, old.tokens() + refill);
            Bucket next = new Bucket(Math.max(0, available - 1), old.refilledAt() + refill * TimeUnit.SECONDS.toNanos(1));
            if (bucket.compareAndSet(old, next)) return available > 0;
        }
    }
    private void expire(Request request, long now) {
        // Capture before claiming emission: a losing phase-close observer can then
        // restore its parent without changing the winning observer's snapshot.
        View view = request.view.get();
        if (closed.get() || now < request.deadline || !request.emitted.compareAndSet(false, true)) return;
        if (!takeToken(now)) { suppressed.incrementAndGet(); return; }
        MergeObservation observation = merge.get();
        StringBuilder event = new StringBuilder("{\"event\":\"public_search_native_deadline\",\"elapsedMs\":")
            .append(ms(now - request.started)).append(",\"active\":\"").append(view.active().phase())
            .append("\",\"activeMs\":").append(ms(now - view.active().started()))
            .append(",\"overlappingPhaseMs\":{");
        boolean comma = false;
        for (var entry : view.durations().entrySet()) {
            if (comma) event.append(',');
            comma = true;
            event.append('"').append(entry.getKey()).append("\":").append(ms(entry.getValue()));
        }
        event.append("},\"omitted\":").append(view.omitted())
            .append(",\"background\":[");
        comma = false;
        for (String phase : backgroundPhases()) {
            if (comma) event.append(',');
            comma = true;
            event.append('"').append(phase).append('"');
        }
        event.append("],\"saturated\":").append(saturated.get())
            .append(",\"backgroundSaturated\":").append(backgroundSaturated.get())
            .append(",\"mergeObservedThreads\":").append(observation.threads())
            .append(",\"mergeSampleIntervalMs\":1000,\"mergeSampleAgeMs\":")
            .append(observation.sampledAt() == 0 ? -1 : ms(now - observation.sampledAt()));
        if (request.trace != null) event.append(",\"traceparent\":\"").append(request.trace).append('"');
        event.append('}');
        emit(event.toString());
    }
    private static long ms(long nanos) { return TimeUnit.NANOSECONDS.toMillis(Math.max(0, nanos)); }
    private void emit(String event) {
        // All strings are fixed enums or validated ASCII headers. This guard is also the byte bound.
        if (!closed.get() && event.length() <= 2048) {
            try { events.accept(event); } catch (RuntimeException ignored) { /* Diagnostic sinks cannot fail work. */ }
        }
    }
    private void sampleMerge() {
        try { merge.set(new MergeObservation(Math.max(0, mergeThreads.getAsInt()), clock.getAsLong())); }
        catch (RuntimeException ignored) { merge.set(new MergeObservation(0, clock.getAsLong())); }
    }
    List<String> backgroundPhases() {
        List<String> phases = new ArrayList<>(8);
        for (int i = 0; i < background.length(); i++) {
            Running running = background.get(i);
            if (running != null) phases.add(running.phase().name());
        }
        return List.copyOf(phases);
    }
    int activeCount() {
        int count = 0;
        for (int i = 0; i < requests.length(); i++) if (requests.get(i) != null) count++;
        return count;
    }
    boolean observersStopped() {
        return (watchdog == null || watchdog.isShutdown()) && (sampler == null || sampler.isShutdown());
    }
    @Override public void destroy() {
        closed.set(true);
        OWNER.compareAndSet(this, null);
        if (watchdog != null) watchdog.shutdownNow();
        if (sampler != null) sampler.shutdownNow();
        for (int i = 0; i < requests.length(); i++) requests.set(i, null);
        for (int i = 0; i < background.length(); i++) background.set(i, null);
    }
}
