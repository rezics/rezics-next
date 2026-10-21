package com.rezics.jena;

import static org.junit.Assert.*;

import java.io.IOException;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.Test;

/** In-process servlet fixtures exercise the actual filter/lifecycle and native
 * deadline owner. No listener, engine, runtime capture or original proof runs. */
public class RequestReadLifecycleObservationTest {
    private static final String A = "1".repeat(32), B = "2".repeat(32);
    private static String parent(String trace) { return "00-" + trace + "-" + "3".repeat(16) + "-01"; }
    private static HttpServletRequest request(String allocation, String traceparent) {
        return (HttpServletRequest) Proxy.newProxyInstance(RequestReadLifecycleObservationTest.class.getClassLoader(),
            new Class<?>[] { HttpServletRequest.class }, (proxy, method, args) -> {
                if (method.getName().equals("getHeader")) {
                    if (args[0].equals(QueryWorkService.READ_BUDGET_HEADER)) return allocation;
                    if (args[0].equals("traceparent")) return traceparent;
                    throw new AssertionError("observation read an unrelated header");
                }
                throw new AssertionError("observation retained/read request data: " + method.getName());
            });
    }
    private static HttpServletResponse response(List<Integer> refusals) {
        return (HttpServletResponse) Proxy.newProxyInstance(RequestReadLifecycleObservationTest.class.getClassLoader(),
            new Class<?>[] { HttpServletResponse.class }, (proxy, method, args) -> {
                if (method.getName().equals("sendError")) { refusals.add((Integer) args[0]); return null; }
                throw new AssertionError("unexpected response access: " + method.getName());
            });
    }
    private static final class Fixture {
        final QueryWorkService.ReadWorkerLifecycle owner = new QueryWorkService.ReadWorkerLifecycle();
        final QueryWorkService.ReadBoundaryFilter filter = new QueryWorkService.ReadBoundaryFilter(owner);
        final List<Integer> refusals = new ArrayList<>();
        final HttpServletResponse response = response(refusals);
        void read(String trace, FilterChain chain) throws Exception { filter.doFilter(request(null, trace), response, chain); }
        void read(String trace) throws Exception { read(trace, (request, response) -> {}); }
    }
    private static void conserved(QueryWorkService.ReadWorkerMeter meter) {
        assertEquals(meter.starts(), meter.released() + meter.active() + meter.pending());
        // There is no queue inside this synchronous filter. This is not a claim
        // about Jetty dispatch or engine/lock/transaction queues outside it.
        assertEquals(0, meter.pending());
        if (meter.active() == 0) assertNotNull(meter.zeroSince()); else assertNull(meter.zeroSince());
    }
    private static void finish(QueryWorkService.ReadWorkerObservation observation) throws Exception {
        observation.detach(); assertTrue("source delivery did not close", observation.drain());
        assertFalse(observation.status().attached());
        assertNotNull(observation.status().detachedAt());
        assertEquals(0, observation.status().pendingNotifications());
    }
    private static void await(CountDownLatch latch) throws IOException {
        try { if (!latch.await(3, TimeUnit.SECONDS)) throw new IOException("fixture gate timed out"); }
        catch (InterruptedException interrupted) { throw new IOException(interrupted); }
    }
    private static void settle(CountDownLatch latch) {
        boolean interrupted = false;
        while (true) {
            try { if (!latch.await(3, TimeUnit.SECONDS)) throw new AssertionError("cleanup gate timed out"); break; }
            catch (InterruptedException cancellation) { interrupted = true; }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    @Test(timeout = 5_000) public void defaultAttachmentUsesActualFilterAndPreservesRequestIdentity() throws Exception {
        var events = new CopyOnWriteArrayList<QueryWorkService.ReadWorkerEvent>();
        var observation = QueryWorkService.observeReadWorkers(events::add);
        try {
            assertTrue(observation.status().complete());
            var filter = new QueryWorkService.ReadBoundaryFilter();
            var request = request(null, parent(A));
            var response = response(new ArrayList<>());
            filter.doFilter(request, response, (actualRequest, actualResponse) -> {
                assertSame(request, actualRequest); assertSame(response, actualResponse);
                assertEquals(1, observation.status().totals().active());
            });
        } finally { finish(observation); }
        assertEquals(List.of("snapshot", "started", "released"), events.stream().map(event -> event.kind()).toList());
        assertEquals(A, events.get(1).trace());
        assertEquals(events.get(1).worker(), events.get(2).worker());
        assertEquals(1, observation.status().totals().released());
        assertTrue(observation.status().complete());
        for (var event : events) conserved(event.totals());
    }

    @Test(timeout = 5_000) public void refusedAndFailedAttemptsRemainCumulativeBetweenSnapshots() throws Exception {
        var fixture = new Fixture();
        var events = new CopyOnWriteArrayList<QueryWorkService.ReadWorkerEvent>();
        var observation = fixture.owner.observe(events::add);
        try {
            for (String invalid : List.of("0", "10001", "-1", "NaN", "1.5"))
                fixture.filter.doFilter(request(invalid, parent(A)), fixture.response,
                    (request, response) -> fail("refused allocation reached execution"));
            var failure = new IOException("real chain failure");
            try { fixture.read(parent(A), (request, response) -> { throw failure; }); fail("failure disappeared"); }
            catch (IOException actual) { assertSame(failure, actual); }
            var runtimeFailure = new IllegalStateException("runtime failure");
            try { fixture.read(parent(B), (request, response) -> { throw runtimeFailure; }); fail("failure disappeared"); }
            catch (IllegalStateException actual) { assertSame(runtimeFailure, actual); }
            var servletFailure = new jakarta.servlet.ServletException("servlet failure");
            try { fixture.read(null, (request, response) -> { throw servletFailure; }); fail("failure disappeared"); }
            catch (jakarta.servlet.ServletException actual) { assertSame(servletFailure, actual); }
            assertEquals(List.of(400, 400, 400, 400, 400), fixture.refusals);
            assertEquals(8, observation.status().totals().starts());
            assertEquals(8, observation.status().totals().released());
            conserved(observation.status().totals());
        } finally { finish(observation); }
        assertEquals(17, events.size());
        assertTrue(observation.status().complete());
        for (var event : events) conserved(event.totals());
    }

    @Test(timeout = 8_000) public void concurrentSelectedAndUnmatchedWorkRetainsRealStartsAndZeroTransitions() throws Exception {
        var fixture = new Fixture();
        var events = new CopyOnWriteArrayList<QueryWorkService.ReadWorkerEvent>();
        var observation = fixture.owner.observe(events::add);
        var entered = new CountDownLatch(2); var release = new CountDownLatch(1);
        long before = System.currentTimeMillis();
        try (var threads = Executors.newFixedThreadPool(2)) {
            var first = threads.submit(() -> { fixture.read(parent(A), (request, response) -> { entered.countDown(); await(release); }); return null; });
            var second = threads.submit(() -> { fixture.read(parent(B), (request, response) -> { entered.countDown(); await(release); }); return null; });
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                assertEquals(2, observation.status().totals().active());
                assertNull(observation.status().totals().zeroSince());
                assertTrue(observation.status().totals().lastStartAt() >= before);
                for (String invalid : List.of("bad", parent("0".repeat(32)), "00-" + A + "-" + "0".repeat(16) + "-01"))
                    fixture.read(invalid);
                fixture.read(null);
                assertEquals(6, observation.status().totals().starts());
                assertEquals(4, observation.status().totals().released());
                conserved(observation.status().totals());
            } finally { release.countDown(); }
            first.get(2, TimeUnit.SECONDS); second.get(2, TimeUnit.SECONDS);
            assertEquals(0, observation.status().totals().active());
            assertTrue(observation.status().totals().zeroSince() >= observation.status().totals().lastStartAt());
            assertTrue(observation.status().totals().zeroSince() <= System.currentTimeMillis());
        } finally { release.countDown(); finish(observation); }
        assertEquals(1, events.stream().filter(event -> event.kind().equals("started") && A.equals(event.trace())).count());
        assertEquals(1, events.stream().filter(event -> event.kind().equals("released") && A.equals(event.trace())).count());
        assertEquals(4, events.stream().filter(event -> event.kind().equals("started") && event.trace() == null).count());
        assertEquals(6, events.stream().filter(event -> event.kind().equals("started")).map(event -> event.worker()).distinct().count());
        for (var event : events) conserved(event.totals());
    }

    private void departure(boolean deadline) throws Exception {
        var fixture = new Fixture();
        var events = new CopyOnWriteArrayList<QueryWorkService.ReadWorkerEvent>();
        var observation = fixture.owner.observe(events::add);
        var entered = new CountDownLatch(1); var departed = new CountDownLatch(1); var release = new CountDownLatch(1);
        var boundary = new AtomicReference<QueryWorkService.ReadBoundary>();
        try (var thread = Executors.newSingleThreadExecutor()) {
            var work = thread.submit(() -> {
                fixture.read(parent(A), (request, response) -> {
                    try (var actual = new QueryWorkService.ReadBoundary(deadline ? 150 : 10_000)) {
                        boundary.set(actual); entered.countDown();
                        try { release.await(3, TimeUnit.SECONDS); fail("departure never interrupted native work"); }
                        catch (InterruptedException cancellation) { departed.countDown(); settle(release); }
                    }
                    assertFalse("boundary interrupt leaked after close", Thread.currentThread().isInterrupted());
                });
                return null;
            });
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                if (!deadline) boundary.get().cancel("client-cancelled");
                assertTrue("real boundary did not interrupt work", departed.await(1, TimeUnit.SECONDS));
                // Actual work still owns its cleanup. An interrupt is not release.
                assertEquals(1, observation.status().totals().active());
                assertEquals(0, observation.status().totals().released());
                conserved(observation.status().totals());
            } finally { release.countDown(); }
            work.get(2, TimeUnit.SECONDS);
            assertEquals(1, observation.status().totals().released());
            var retry = thread.submit(() -> {
                assertFalse(Thread.currentThread().isInterrupted());
                QueryWorkService.ReadBoundary.checkCurrent(); fixture.read(parent(B)); return null;
            });
            retry.get(2, TimeUnit.SECONDS);
            assertEquals(2, observation.status().totals().starts());
            assertEquals(2, observation.status().totals().released());
            conserved(observation.status().totals());
        } finally { release.countDown(); finish(observation); }
        assertTrue(observation.status().complete());
        assertEquals(List.of("snapshot", "started", "released", "started", "released"),
            events.stream().map(event -> event.kind()).toList());
        boundary.set(null);
    }
    @Test(timeout = 8_000) public void actualDeadlineDoesNotReleaseUntilNativeCleanupSettlesAndRetryIsIndependent() throws Exception { departure(true); }
    @Test(timeout = 8_000) public void actualCancellationDoesNotReleaseUntilNativeCleanupSettlesAndRetryIsIndependent() throws Exception { departure(false); }

    @Test(timeout = 5_000) public void subscriberFailureCannotChangeErrorsOtherSubscribersOrOrdinaryWork() throws Exception {
        var fixture = new Fixture();
        var failing = fixture.owner.observe(event -> { throw new AssertionError("private sink failure"); });
        var events = new CopyOnWriteArrayList<QueryWorkService.ReadWorkerEvent>();
        var healthy = fixture.owner.observe(events::add);
        try {
            fixture.read(parent(A));
            var error = new IOException("unchanged");
            try { fixture.read(parent(B), (request, response) -> { throw error; }); fail(); }
            catch (IOException actual) { assertSame(error, actual); }
        } finally { finish(failing); finish(healthy); }
        assertEquals(5, failing.status().failures());
        assertFalse(failing.status().complete());
        assertTrue(healthy.status().complete());
        assertEquals(5, events.size());
        conserved(healthy.status().totals());
        fixture.read(null);
        assertEquals(5, events.size());
    }

    @Test(timeout = 8_000) public void blockedSinkIsBoundedNonblockingAndDropsNeverBecomeKnownZero() throws Exception {
        var fixture = new Fixture();
        var entered = new CountDownLatch(1); var release = new CountDownLatch(1);
        var observation = fixture.owner.observe(event -> { entered.countDown(); settle(release); });
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            try (var thread = Executors.newSingleThreadExecutor()) {
                var work = thread.submit(() -> { for (int index = 0; index < 100; index++) fixture.read(parent(A)); return null; });
                work.get(1, TimeUnit.SECONDS);
            }
            assertEquals(100, observation.status().totals().starts());
            assertEquals(100, observation.status().totals().released());
            assertTrue(observation.status().dropped() > 0);
            assertTrue(observation.status().pendingNotifications() <= 65);
            assertFalse(observation.status().complete());
            conserved(observation.status().totals());
            observation.detach();
            assertFalse("blocked source drain claimed close", observation.drain());
            assertTrue(observation.status().pendingNotifications() > 0);
        } finally { release.countDown(); finish(observation); }
        assertFalse(observation.status().complete());
    }

    @Test(timeout = 8_000) public void lateAndInterruptedCoverageCannotClaimZeroAndDetachedDeliveryClears() throws Exception {
        var fixture = new Fixture();
        fixture.read(parent(A));
        var late = fixture.owner.observe(event -> {});
        assertFalse(late.status().complete()); finish(late);
        var fresh = new Fixture();
        var events = new CopyOnWriteArrayList<QueryWorkService.ReadWorkerEvent>();
        var observation = fresh.owner.observe(events::add);
        var entered = new CountDownLatch(1); var release = new CountDownLatch(1);
        try (var thread = Executors.newSingleThreadExecutor()) {
            var work = thread.submit(() -> { fresh.read(parent(A), (request, response) -> { entered.countDown(); await(release); }); return null; });
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                observation.detach(); assertTrue(observation.drain());
                assertFalse(observation.status().complete());
                assertEquals(1, observation.status().totals().active());
                assertEquals(0, observation.status().totals().released());
            } finally { release.countDown(); }
            work.get(2, TimeUnit.SECONDS);
            fresh.read(parent(B));
        } finally { release.countDown(); finish(observation); }
        assertEquals(2, events.size());
        assertNull(observation.status().totals().zeroSince());
        var next = fresh.owner.observe(event -> {});
        assertFalse(next.status().complete()); finish(next);
        var stillLate = fixture.owner.observe(event -> {});
        assertFalse(stillLate.status().complete()); finish(stillLate);
    }

    @Test(timeout = 8_000) public void additiveSubscriberSlotsStayBoundedUntilDetachedSourcesReallyDrain() throws Exception {
        var fixture = new Fixture();
        var release = new CountDownLatch(1); var entered = new CountDownLatch(8);
        var observations = new ArrayList<QueryWorkService.ReadWorkerObservation>();
        try {
            for (int index = 0; index < 8; index++) observations.add(fixture.owner.observe(event -> { entered.countDown(); settle(release); }));
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            assertThrows(IllegalStateException.class, () -> fixture.owner.observe(event -> {}));
            for (var observation : observations) observation.detach();
            assertFalse(observations.getFirst().drain());
            assertThrows(IllegalStateException.class, () -> fixture.owner.observe(event -> {}));
        } finally {
            release.countDown();
            for (var observation : observations) finish(observation);
        }
        var replacement = fixture.owner.observe(event -> {});
        assertTrue(replacement.status().complete()); finish(replacement);
    }

    @Test(timeout = 5_000) public void unobservedReadsHaveNoObserverHistoryAndIndependentOwnersKeepTheirOwnLifetime() throws Exception {
        var fixture = new Fixture(); var independent = new Fixture();
        var request = request(null, "invalid");
        fixture.filter.doFilter(request, fixture.response, (actual, response) -> assertSame(request, actual));
        var late = fixture.owner.observe(event -> {});
        var first = independent.owner.observe(event -> {});
        try {
            assertFalse(late.status().complete());
            assertTrue(first.status().complete());
            assertEquals(0, first.status().totals().starts());
            independent.read(parent(A));
            assertEquals(0, late.status().totals().starts());
            assertEquals(1, first.status().totals().released());
        } finally { finish(late); finish(first); }
    }
    @Test public void dispatchAndMalformedOrFutureDeadlinesNeverRenewTheLocalAllocation() {
        long began = System.nanoTime() - TimeUnit.MILLISECONDS.toNanos(70);
        long cap = began + TimeUnit.MILLISECONDS.toNanos(100);
        for (String header : new String[] {null, "", "invalid", "0", "-1", "1.5", "9007199254740992",
                Long.toString(System.currentTimeMillis() + 60_000)})
            assertEquals(cap, QueryWorkService.readDeadline(100, header, began));
        assertTrue(QueryWorkService.readDeadline(100, Long.toString(System.currentTimeMillis() - 1), began)
            <= System.nanoTime());
        long partlySpent = QueryWorkService.readDeadline(1000, Long.toString(System.currentTimeMillis() + 50), System.nanoTime());
        assertTrue(partlySpent - System.nanoTime() <= TimeUnit.MILLISECONDS.toNanos(50));
    }

    @SuppressWarnings("unchecked")
    @Test(timeout = 5_000) public void nestedBoundariesRetainParentDeadlineCancellationAndThreadCleanup() throws Exception {
        var field = QueryWorkService.ReadBoundary.class.getDeclaredField("CURRENT");
        field.setAccessible(true);
        var current = (ThreadLocal<QueryWorkService.ReadBoundary>) field.get(null);
        assertNull(current.get());
        try (var outer = new QueryWorkService.ReadBoundary(1000)) {
            current.set(outer);
            long deadline = QueryWorkService.ReadBoundary.deadline(Long.MAX_VALUE);
            try (var inner = new QueryWorkService.ReadBoundary(10_000)) {
                current.set(inner);
                assertEquals(deadline, QueryWorkService.ReadBoundary.deadline(Long.MAX_VALUE));
                outer.cancel("client-cancelled");
                var failure = assertThrows(org.apache.jena.query.QueryCancelledException.class,
                    QueryWorkService.ReadBoundary::checkCurrent);
                assertTrue(failure.getCause().getMessage().contains("client-cancelled"));
            } finally { current.set(outer); }
        } finally { current.remove(); }
        assertFalse(Thread.currentThread().isInterrupted());
        try (var retry = new QueryWorkService.ReadBoundary(1000)) {
            current.set(retry);
            QueryWorkService.ReadBoundary.checkCurrent();
        } finally { current.remove(); }
    }

}
