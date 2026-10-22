package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecution;
import org.junit.Test;

/** Actual native objects and bounded filesystem transport; these are producer
 * checks, not a running Site acceptance result. */
public class NativeReadLifecycleObservationTest {
    private static final String A = "a".repeat(32), B = "b".repeat(32);

    private static void finish(QueryWorkService.ReadWorkerObservation source) throws Exception {
        source.detach(); assertTrue(source.drain()); assertEquals(0, source.status().pendingNotifications());
    }
    private static void conserved(QueryWorkService.ReadWorkerMeter value) {
        assertEquals(value.starts(), value.released() + value.active() + value.pending());
        if (value.active() + value.pending() == 0) assertNotNull(value.zeroSince()); else assertNull(value.zeroSince());
    }
    private static void await(CountDownLatch gate) {
        try { assertTrue(gate.await(2, TimeUnit.SECONDS)); }
        catch (InterruptedException failure) { Thread.currentThread().interrupt(); throw new AssertionError(failure); }
    }
    private static Path directory() throws Exception {
        Files.createDirectories(Path.of(".temp"));
        return Files.createTempDirectory(Path.of(".temp"), "native-read-observation-");
    }
    private static JsonObject capture(Path directory, String nonce) throws Exception {
        long before = System.currentTimeMillis();
        Path pending = directory.resolve("request.pending");
        Files.writeString(pending, nonce, StandardCharsets.US_ASCII);
        Files.move(pending, directory.resolve("request"), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (System.nanoTime() < deadline) {
            var result = JSON.parse(Files.readString(directory.resolve("snapshot.json")));
            if (nonce.equals(result.get("request").getAsString().value())) {
                assertTrue(result.get("capturedAt").getAsNumber().value().longValue() >= before);
                return result;
            }
            Thread.sleep(5);
        }
        throw new AssertionError("fresh native snapshot did not arrive");
    }
    private static JsonObject source(JsonObject snapshot, String name) { return snapshot.get("sources").getAsObject().get(name).getAsObject(); }

    @Test(timeout = 8_000) public void pendingAcquisitionAndActualReleaseRemainDistinctPerTrace() throws Exception {
        var owner = new QueryWorkService.ReadWorkerLifecycle(); var source = owner.observe(event -> {});
        try {
            var first = owner.enter(A, true); var second = owner.enter(B, false); var unmatched = owner.enter((String) null, false);
            assertEquals(1, source.status().totals().pending()); assertEquals(2, source.status().totals().active());
            conserved(source.status().totals());
            assertEquals(1, source.snapshot().traces().get(A).pending());
            first.activate(); first.activate();
            assertEquals(0, source.status().totals().pending()); assertEquals(3, source.status().totals().active());
            second.close(); first.close(); first.close();
            assertEquals(1, source.status().totals().active());
            assertEquals(1, source.snapshot().traces().get(A).released());
            assertEquals(1, source.snapshot().traces().get(B).released());
            unmatched.close(); conserved(source.status().totals());
            assertEquals(3, source.status().totals().released()); assertEquals(2, source.snapshot().traces().size());
        } finally { finish(source); }
        assertTrue(source.status().complete());
    }

    @Test(timeout = 8_000) public void nativeLockWaitIsPendingUntilAcquiredAndIsNotReleasedByCancellation() throws Exception {
        var source = QueryWorkService.READ_LOCKS.observe(event -> {});
        var lock = new ReentrantLock(); lock.lock();
        var acquired = new CountDownLatch(1); var release = new CountDownLatch(1);
        try (var threads = Executors.newSingleThreadExecutor()) {
            var work = threads.submit(() -> {
                QueryWorkService.READ_TRACE.set(A);
                try {
                    var flight = QueryWorkService.ReadBoundary.lockForRead(lock);
                    try { acquired.countDown(); await(release); }
                    finally { lock.unlock(); if (flight != null) flight.close(); }
                } finally { QueryWorkService.READ_TRACE.remove(); }
            });
            try {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                while (source.status().totals().pending() == 0 && System.nanoTime() < deadline) Thread.sleep(2);
                assertEquals(1, source.status().totals().pending()); assertEquals(0, source.status().totals().active());
                lock.unlock(); assertTrue(acquired.await(2, TimeUnit.SECONDS));
                assertEquals(0, source.status().totals().pending()); assertEquals(1, source.status().totals().active());
                assertEquals(0, source.status().totals().released());
            } finally { if (lock.isHeldByCurrentThread()) lock.unlock(); release.countDown(); }
            work.get(2, TimeUnit.SECONDS);
        } finally { if (lock.isHeldByCurrentThread()) lock.unlock(); release.countDown(); finish(source); }
        assertEquals(1, source.status().totals().released()); conserved(source.status().totals());
        assertEquals(1, source.snapshot().traces().get(A).released());
    }

    @Test(timeout = 8_000) public void actualEngineAbortDoesNotReleaseBeforeCloseAndTransactionEndIsSeparate() throws Exception {
        var engines = QueryWorkService.READ_ENGINES.observe(event -> {});
        var transactions = QueryWorkService.READ_TRANSACTIONS.observe(event -> {});
        var dataset = DatasetFactory.createTxnMem();
        QueryWorkService.READ_TRACE.set(A);
        try {
            QueryWorkService.beginRead(dataset.asDatasetGraph());
            var execution = QueryWorkService.readEngine(QueryExecution.class,
                () -> QueryExecution.dataset(dataset).query("SELECT ?s WHERE { VALUES ?s { 1 2 3 } }").build());
            try {
                assertTrue(execution.execSelect().hasNext());
                execution.abort();
                assertEquals(1, engines.status().totals().active()); assertEquals(0, engines.status().totals().released());
                assertEquals(1, transactions.status().totals().active());
            } finally { execution.close(); }
            assertEquals(1, engines.status().totals().released()); assertEquals(0, engines.status().totals().active());
            assertEquals(1, transactions.status().totals().active());
            QueryWorkService.endRead(dataset.asDatasetGraph());
            assertFalse(dataset.isInTransaction()); assertEquals(1, transactions.status().totals().released());
            conserved(engines.status().totals()); conserved(transactions.status().totals());
        } finally {
            if (dataset.isInTransaction()) QueryWorkService.endRead(dataset.asDatasetGraph());
            dataset.close(); QueryWorkService.READ_TRACE.remove(); finish(engines); finish(transactions);
        }
    }

    @Test(timeout = 8_000) public void transactionBeginWaitRemainsPendingUntilActualBeginReturns() throws Exception {
        var source = QueryWorkService.READ_TRANSACTIONS.observe(event -> {});
        var entered = new CountDownLatch(1); var begin = new CountDownLatch(1); var acquired = new CountDownLatch(1); var end = new CountDownLatch(1);
        var dataset = DatasetFactory.createTxnMem();
        try (var threads = Executors.newSingleThreadExecutor()) {
            var work = threads.submit(() -> {
                QueryWorkService.READ_TRACE.set(B);
                try {
                    QueryWorkService.beginRead(() -> { entered.countDown(); await(begin); dataset.begin(org.apache.jena.query.ReadWrite.READ); });
                    try { acquired.countDown(); await(end); }
                    finally { QueryWorkService.endRead(dataset.asDatasetGraph()); }
                } finally { QueryWorkService.READ_TRACE.remove(); }
            });
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                assertEquals(1, source.status().totals().pending()); assertEquals(0, source.status().totals().active());
                begin.countDown(); assertTrue(acquired.await(2, TimeUnit.SECONDS));
                assertEquals(0, source.status().totals().pending()); assertEquals(1, source.status().totals().active());
            } finally { begin.countDown(); end.countDown(); }
            work.get(2, TimeUnit.SECONDS);
        } finally { begin.countDown(); end.countDown(); dataset.close(); finish(source); }
        assertEquals(1, source.status().totals().released()); conserved(source.status().totals());
    }

    @Test(timeout = 8_000) public void privateFreshSnapshotAndCloseReceiptUseActualCountersAndAtomicFlush() throws Exception {
        var worker = new QueryWorkService.ReadWorkerLifecycle(); var engine = new QueryWorkService.ReadWorkerLifecycle();
        var lock = new QueryWorkService.ReadWorkerLifecycle(); var transaction = new QueryWorkService.ReadWorkerLifecycle();
        var directory = directory();
        var transport = new NativeReadObservation(directory, Map.of("native-worker", worker, "native-engine", engine,
            "native-lock", lock, "native-transaction", transaction));
        try {
            var flight = worker.enter(A, false); var waiting = lock.enter(A, true);
            try {
                var snapshot = capture(directory, "active-1");
                assertTrue(snapshot.get("complete").getAsBoolean().value());
                assertEquals(0, snapshot.get("dropped").getAsNumber().value().longValue());
                assertEquals(1, source(snapshot, "native-worker").get("traces").getAsObject().get(A).getAsObject().get("active").getAsNumber().value().longValue());
                assertEquals(1, source(snapshot, "native-lock").get("status").getAsObject().get("totals").getAsObject().get("pending").getAsNumber().value().longValue());
                assertEquals(0, source(snapshot, "native-engine").get("traces").getAsObject().keys().size());
                assertTrue(source(snapshot, "native-worker").get("attachedAt").getAsNumber().value().longValue() <= snapshot.get("capturedAt").getAsNumber().value().longValue());
            } finally { waiting.close(); flight.close(); }
            var snapshot = capture(directory, "released-2");
            assertEquals(1, source(snapshot, "native-worker").get("status").getAsObject().get("totals").getAsObject().get("released").getAsNumber().value().longValue());
        } finally { transport.close(); }
        var snapshot = JSON.parse(Files.readString(directory.resolve("snapshot.json")));
        var receipt = JSON.parse(Files.readString(directory.resolve("receipt.json")));
        assertTrue(snapshot.get("closed").getAsBoolean().value()); assertTrue(snapshot.get("drained").getAsBoolean().value());
        assertTrue(snapshot.get("complete").getAsBoolean().value());
        byte[] bytes = Files.readAllBytes(directory.resolve("snapshot.json"));
        assertEquals(bytes.length, receipt.get("snapshotBytes").getAsNumber().value().intValue());
        assertEquals(java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)), receipt.get("snapshotSha256").getAsString().value());
        for (String name : snapshot.get("sources").getAsObject().keys()) {
            var status = source(snapshot, name).get("status").getAsObject();
            assertFalse(status.get("attached").getAsBoolean().value()); assertEquals(0, status.get("pendingNotifications").getAsNumber().value().intValue());
        }
        assertThrows(java.io.IOException.class, () -> new NativeReadObservation(directory));
    }

    @Test(timeout = 8_000) public void lateOrInterruptedCaptureNeverBecomesCompleteAndStopDrains() throws Exception {
        var owner = new QueryWorkService.ReadWorkerLifecycle();
        try (var ignored = owner.enter(A, false)) {}
        var directory = directory();
        try (var transport = new NativeReadObservation(directory, Map.of("native-worker", owner))) {
            var snapshot = capture(directory, "late");
            assertFalse(snapshot.get("complete").getAsBoolean().value());
        }
        var fresh = new QueryWorkService.ReadWorkerLifecycle(); var second = directory();
        var transport = new NativeReadObservation(second, Map.of("native-worker", fresh));
        var flight = fresh.enter(A, true);
        try {
            Files.writeString(second.resolve("stop"), "stop");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            while (!Files.exists(second.resolve("receipt.json")) && System.nanoTime() < deadline) Thread.sleep(5);
            assertTrue(Files.exists(second.resolve("receipt.json")));
            var snapshot = JSON.parse(Files.readString(second.resolve("snapshot.json")));
            assertTrue(snapshot.get("drained").getAsBoolean().value());
            assertFalse(snapshot.get("complete").getAsBoolean().value());
            assertEquals(1, source(snapshot, "native-worker").get("status").getAsObject().get("totals").getAsObject().get("pending").getAsNumber().value().longValue());
        } finally { flight.close(); transport.close(); }
    }

    @Test(timeout = 8_000) public void traceRetentionIsBoundedAndOverflowCannotBecomeKnownZero() throws Exception {
        var owner = new QueryWorkService.ReadWorkerLifecycle(); var source = owner.observe(event -> {});
        try {
            for (int index = 1; index <= 4097; index++) {
                String trace = String.format("%032x", index);
                try (var ignored = owner.enter(trace, false)) {}
            }
            assertEquals(4096, source.snapshot().traces().size());
            assertEquals(4097, source.status().totals().starts()); assertEquals(4097, source.status().totals().released());
            assertTrue(source.status().dropped() > 0); assertFalse(source.status().complete());
            conserved(source.status().totals());
        } finally { finish(source); }
    }

    @Test(timeout = 8_000) public void failedTransactionEndRetainsActiveOwnershipAndMarksCoverageIncomplete() throws Exception {
        var source = QueryWorkService.READ_TRANSACTIONS.observe(event -> {});
        var dataset = DatasetFactory.createTxnMem(); var failure = new IllegalStateException("end did not run");
        try {
            QueryWorkService.beginRead(dataset.asDatasetGraph());
            assertSame(failure, assertThrows(IllegalStateException.class,
                () -> QueryWorkService.endRead(() -> { throw failure; })));
            assertTrue(dataset.isInTransaction());
            assertEquals(1, source.status().totals().active()); assertEquals(0, source.status().totals().released());
            assertFalse(source.status().complete()); assertTrue(source.status().failures() > 0);
            conserved(source.status().totals());
        } finally { if (dataset.isInTransaction()) dataset.end(); dataset.close(); finish(source); }
    }

    @Test(timeout = 8_000) public void publisherFenceAlsoRemainsVisibleInWholeRuntimeLockTotals() throws Exception {
        var source = QueryWorkService.READ_LOCKS.observe(event -> {});
        try {
            try (var fence = SearchDeltaJournal.publicationFence()) {
                assertEquals(1, source.status().totals().active());
                assertEquals(0, source.status().totals().released());
                assertNull(source.status().totals().zeroSince());
            }
            assertEquals(0, source.status().totals().active());
            assertEquals(1, source.status().totals().released()); conserved(source.status().totals());
        } finally { finish(source); }
    }

    @Test(timeout = 8_000) public void actualQueryExecDelegatesLazyRowsAndClosesOnlyItsOwnEngine() throws Exception {
        var source = QueryWorkService.READ_ENGINES.observe(event -> {});
        var dataset = DatasetFactory.createTxnMem();
        QueryWorkService.READ_TRACE.set(B);
        try {
            dataset.begin(org.apache.jena.query.ReadWrite.READ);
            var first = QueryWorkService.readEngine(org.apache.jena.sparql.exec.QueryExec.class,
                () -> org.apache.jena.sparql.exec.QueryExec.dataset(dataset.asDatasetGraph()).query("SELECT ?s WHERE { VALUES ?s { 1 2 3 } }").build());
            var second = QueryWorkService.readEngine(org.apache.jena.sparql.exec.QueryExec.class,
                () -> org.apache.jena.sparql.exec.QueryExec.dataset(dataset.asDatasetGraph()).query("ASK { }").build());
            try {
                var rows = first.select(); assertTrue(rows.hasNext()); rows.next();
                assertEquals(2, source.status().totals().active());
                first.close(); assertTrue(first.isClosed());
                assertEquals(1, source.status().totals().active()); assertEquals(1, source.status().totals().released());
                assertTrue(second.ask());
            } finally { first.close(); second.close(); }
            assertEquals(0, source.status().totals().active()); assertEquals(2, source.status().totals().released());
            conserved(source.status().totals());
        } finally { if (dataset.isInTransaction()) dataset.end(); dataset.close(); QueryWorkService.READ_TRACE.remove(); finish(source); }
    }
}
