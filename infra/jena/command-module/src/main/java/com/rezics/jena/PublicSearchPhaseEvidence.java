package com.rezics.jena;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
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
    enum Phase { REQUEST, QUERY, READER_OPEN, PARSE, RANK, WITNESS, PROOF, TEXT_PREPARE,
        TEXT_COMMIT, QUALIFICATION, AUDIT, RECOVERY, OCCURRENCE_DISCOVERY, OCCURRENCE_PROJECT, MERGE, COMMAND }
    private record Running(Phase phase, long started) {}
    private record View(Running active, Map<Phase, Long> durations, long omitted) {}
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
        Request previous = CURRENT.get();
        Scope previousSequential = SEQUENTIAL.get();
        CURRENT.set(request);
        SEQUENTIAL.remove();
        try { chain.doFilter(servlet, response); }
        finally {
            expire(request, clock.getAsLong());
            endPhase();
            requests.compareAndSet(slot, request, null);
            if (previous == null) CURRENT.remove(); else CURRENT.set(previous);
            if (previousSequential != null) SEQUENTIAL.set(previousSequential);
        }
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
            View previous = request.view.getAndUpdate(view -> new View(running, view.durations(), view.omitted()));
            return new Scope(() -> {
                owner.expire(request, owner.clock.getAsLong());
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
