package com.rezics.jena;

import static org.junit.Assert.*;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;

public class PublicSearchPhaseEvidenceTest {
    private static final String TRACE = "00-11111111111111111111111111111111-2222222222222222-01";
    private static HttpServletRequest request(String budget, String trace) {
        return (HttpServletRequest) Proxy.newProxyInstance(HttpServletRequest.class.getClassLoader(),
            new Class<?>[]{HttpServletRequest.class}, (proxy, method, args) -> {
                if (method.getName().equals("getHeader")) return switch ((String) args[0]) {
                    case "x-rezics-search-budget-ms" -> budget;
                    case "traceparent" -> trace;
                    default -> null;
                };
                throw new AssertionError("Evidence inspected request data: " + method.getName());
            });
    }
    private static void await(CountDownLatch latch) {
        try { assertTrue("controlled work did not enter/release", latch.await(5, TimeUnit.SECONDS)); }
        catch (InterruptedException ex) { Thread.currentThread().interrupt(); throw new AssertionError(ex); }
    }

    @Test public void stalledMergeSamplerCannotBlockDeadlineEvidence() throws Exception {
        CountDownLatch sampling = new CountDownLatch(1), releaseSampler = new CountDownLatch(1);
        CountDownLatch entered = new CountDownLatch(1), releaseRequest = new CountDownLatch(1), emitted = new CountDownLatch(1);
        List<String> events = new CopyOnWriteArrayList<>();
        var evidence = new PublicSearchPhaseEvidence(System::nanoTime, line -> { events.add(line); emitted.countDown(); }, true,
            () -> { sampling.countDown(); await(releaseSampler); return 3; });
        evidence.install();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            await(sampling);
            var worker = executor.submit(() -> {
                evidence.doFilter(request("100", null), null, (req, res) -> { entered.countDown(); await(releaseRequest); });
                return null;
            });
            try {
                await(entered); await(emitted);
                assertFalse(worker.isDone());
                assertTrue(events.getFirst().contains("\"mergeSampleAgeMs\":-1"));
                assertTrue(events.getFirst().contains("\"mergeSampleIntervalMs\":1000"));
            } finally { releaseRequest.countDown(); releaseSampler.countDown(); }
            worker.get(5, TimeUnit.SECONDS);
        } finally { releaseRequest.countDown(); releaseSampler.countDown(); evidence.destroy(); }
        assertTrue(evidence.observersStopped());
    }

    @Test public void watchdogReportsBlockedReaderProofAndMaintenanceBeforeRelease() throws Exception {
        for (var phase : List.of(PublicSearchPhaseEvidence.Phase.READER_OPEN,
                PublicSearchPhaseEvidence.Phase.PROOF, PublicSearchPhaseEvidence.Phase.OCCURRENCE_DISCOVERY)) {
            List<String> events = new CopyOnWriteArrayList<>();
            CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), event = new CountDownLatch(1);
            var evidence = new PublicSearchPhaseEvidence(System::nanoTime, line -> { events.add(line); event.countDown(); }, true);
            evidence.install();
            try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
                var worker = executor.submit(() -> {
                    evidence.doFilter(request("100", TRACE), null, (req, res) -> {
                        try (var scope = PublicSearchPhaseEvidence.phase(phase)) { entered.countDown(); await(release); }
                    });
                    return null;
                });
                try {
                    await(entered); await(event);
                    assertFalse(worker.isDone());
                    assertEquals(1, events.size());
                    assertTrue(events.getFirst().contains("\"active\":\"" + phase + "\""));
                    assertTrue(events.getFirst().contains(TRACE));
                } finally { release.countDown(); }
                worker.get(5, TimeUnit.SECONDS);
                evidence.scan();
                assertEquals(1, events.size());
                assertEquals(0, evidence.activeCount());
                assertTrue(evidence.backgroundPhases().isEmpty());
            } finally { release.countDown(); evidence.destroy(); }
            assertTrue(evidence.observersStopped());
        }
    }

    @Test public void concurrentRequestsHaveIndependentActivePhasesAndCleanup() throws Exception {
        AtomicLong clock = new AtomicLong(1);
        List<String> events = new CopyOnWriteArrayList<>();
        var evidence = new PublicSearchPhaseEvidence(clock::get, events::add, false);
        evidence.install();
        CountDownLatch entered = new CountDownLatch(2), release = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var workers = new ArrayList<java.util.concurrent.Future<?>>();
            for (var phase : List.of(PublicSearchPhaseEvidence.Phase.READER_OPEN, PublicSearchPhaseEvidence.Phase.PROOF))
                workers.add(executor.submit(() -> {
                    evidence.doFilter(request("1", null), null, (req, res) -> {
                        try (var scope = PublicSearchPhaseEvidence.phase(phase)) { entered.countDown(); await(release); }
                    });
                    return null;
                }));
            try {
                await(entered); clock.addAndGet(2_000_000); evidence.scan();
                assertEquals(2, events.size());
                assertTrue(events.stream().anyMatch(line -> line.contains("\"active\":\"READER_OPEN\"")));
                assertTrue(events.stream().anyMatch(line -> line.contains("\"active\":\"PROOF\"")));
            } finally { release.countDown(); }
            for (var worker : workers) worker.get(5, TimeUnit.SECONDS);
            assertEquals(0, evidence.activeCount());
        } finally { release.countDown(); evidence.destroy(); }
    }

    @Test public void activeRequestSaturationAndSuppressionAreBoundedAndVisible() throws Exception {
        AtomicLong clock = new AtomicLong(1);
        List<String> events = new CopyOnWriteArrayList<>();
        var evidence = new PublicSearchPhaseEvidence(clock::get, events::add, false);
        evidence.install();
        CountDownLatch entered = new CountDownLatch(129), release = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var workers = new ArrayList<java.util.concurrent.Future<?>>();
            for (int i = 0; i < 129; i++) workers.add(executor.submit(() -> {
                evidence.doFilter(request("1", null), null, (req, res) -> {
                    try (var scope = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.PROOF)) {
                        entered.countDown(); await(release);
                    }
                });
                return null;
            }));
            try {
                await(entered);
                assertEquals(128, evidence.activeCount());
                assertTrue("saturated requests must not be misreported as maintenance", evidence.backgroundPhases().isEmpty());
                clock.addAndGet(2_000_000); evidence.scan(); evidence.scan();
                assertEquals(8, events.size());
                assertTrue(events.stream().allMatch(line -> line.contains("\"saturated\":1")));
                clock.addAndGet(TimeUnit.MINUTES.toNanos(1)); evidence.scan();
                assertEquals(9, events.size());
                assertTrue(events.getLast().contains("\"suppressed\":120"));
                assertTrue(events.getLast().contains("\"saturated\":1"));
                evidence.scan(); assertEquals(9, events.size());
            } finally { release.countDown(); }
            for (var worker : workers) worker.get(5, TimeUnit.SECONDS);
            assertEquals(0, evidence.activeCount());
        } finally { release.countDown(); evidence.destroy(); }
    }

    @Test public void durationBackgroundAndEventCapsRedactPayloadAndRefillTokens() throws Exception {
        AtomicLong clock = new AtomicLong(1);
        List<String> events = new CopyOnWriteArrayList<>();
        var evidence = new PublicSearchPhaseEvidence(clock::get, events::add, false);
        evidence.install();
        List<PublicSearchPhaseEvidence.Scope> maintenance = new ArrayList<>();
        try {
            for (int i = 0; i < 10; i++) maintenance.add(PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.AUDIT));
            assertEquals(8, evidence.backgroundPhases().size());
            evidence.doFilter(request("1", TRACE), null, (req, res) -> {
                for (var phase : PublicSearchPhaseEvidence.Phase.values()) {
                    try (var scope = PublicSearchPhaseEvidence.phase(phase)) { clock.incrementAndGet(); }
                }
                try (var scope = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.WITNESS)) {
                    clock.addAndGet(2_000_000); evidence.scan();
                }
            });
            String line = events.getFirst();
            assertTrue(line.contains("\"active\":\"WITNESS\""));
            assertTrue(line, line.contains("\"omitted\":" + (PublicSearchPhaseEvidence.Phase.values().length - 8)));
            assertTrue(line.contains("\"backgroundSaturated\":2"));
            String durations = line.split("overlappingPhaseMs")[1].split("}")[0];
            assertEquals(8, durations.chars().filter(c -> c == ':').count() - 1);
            assertTrue(line.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 2048);
            for (int i = 0; i < 8; i++) evidence.doFilter(request("1", null), null, (req, res) -> clock.addAndGet(2_000_000));
            assertEquals(8, events.size());
            clock.addAndGet(TimeUnit.SECONDS.toNanos(1));
            evidence.doFilter(request("1", null), null, (req, res) -> clock.addAndGet(2_000_000));
            assertEquals(9, events.size());
        } finally {
            maintenance.forEach(PublicSearchPhaseEvidence.Scope::close);
            assertTrue(evidence.backgroundPhases().isEmpty());
            evidence.destroy();
        }
    }

    @Test public void invalidHeadersAreIgnoredAndFailureRetainsBreachedPhaseThenCleansUp() throws Exception {
        AtomicLong clock = new AtomicLong(1);
        List<String> events = new CopyOnWriteArrayList<>();
        var evidence = new PublicSearchPhaseEvidence(clock::get, events::add, false);
        evidence.install();
        try {
            for (String budget : new String[]{null, "0", "1501", "-1", "01", "1\n", "99999999999999999999"})
                evidence.doFilter(request(budget, TRACE), null, (req, res) -> assertEquals(0, evidence.activeCount()));
            evidence.doFilter(request("1", "request body secret"), null, (req, res) -> assertEquals(0, evidence.activeCount()));
            assertTrue(events.isEmpty());
            try {
                evidence.doFilter(request("1", TRACE), null, (req, res) -> {
                    try (var scope = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.PROOF)) {
                        clock.addAndGet(2_000_000);
                        throw new ServletException("request body secret");
                    }
                });
                fail("request failure must propagate");
            } catch (ServletException expected) { assertEquals("request body secret", expected.getMessage()); }
            assertEquals(1, events.size());
            assertTrue(events.getFirst().contains("\"active\":\"PROOF\""));
            assertFalse(events.getFirst().contains("secret"));
            assertEquals(0, evidence.activeCount());
            try (var background = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.RECOVERY)) {
                assertEquals(List.of("RECOVERY"), evidence.backgroundPhases());
            }
        } finally { evidence.destroy(); }
        evidence.scan(); assertEquals(1, events.size());
        assertTrue(evidence.observersStopped());
    }

    @Test public void shutdownDuringHeaderAdmissionLeavesNoActiveRecord() throws Exception {
        List<String> events = new CopyOnWriteArrayList<>();
        var evidence = new PublicSearchPhaseEvidence(System::nanoTime, events::add, true);
        evidence.install();
        CountDownLatch reading = new CountDownLatch(1), releaseHeader = new CountDownLatch(1);
        CountDownLatch entered = new CountDownLatch(1), releaseRequest = new CountDownLatch(1);
        HttpServletRequest http = (HttpServletRequest) Proxy.newProxyInstance(HttpServletRequest.class.getClassLoader(),
            new Class<?>[]{HttpServletRequest.class}, (proxy, method, args) -> {
                assertEquals("getHeader", method.getName());
                if (args[0].equals("x-rezics-search-budget-ms")) {
                    reading.countDown(); await(releaseHeader); return "1";
                }
                return null;
            });
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var worker = executor.submit(() -> {
                evidence.doFilter(http, null, (req, res) -> { entered.countDown(); await(releaseRequest); });
                return null;
            });
            try {
                await(reading); evidence.destroy(); releaseHeader.countDown(); await(entered);
                assertEquals(0, evidence.activeCount());
                assertTrue(evidence.backgroundPhases().isEmpty());
                assertTrue(events.isEmpty());
            } finally { releaseHeader.countDown(); releaseRequest.countDown(); }
            worker.get(5, TimeUnit.SECONDS);
        } finally { releaseHeader.countDown(); releaseRequest.countDown(); evidence.destroy(); }
    }
}
