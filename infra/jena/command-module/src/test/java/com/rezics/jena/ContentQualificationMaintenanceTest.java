package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.apache.jena.query.ReadWrite;
import org.junit.Test;

public class ContentQualificationMaintenanceTest {
    @Test public void contentMaintenanceKeepsPhysicalProofWhileCompletenessRemainsUnavailable() throws Exception {
        try (var fixture = new SearchDeltaJournalTest.ContentFixture()) {
            var auditing = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var previous = SearchDeltaJournal.logged;
            try {
                SearchDeltaJournal.logged = line -> {
                    if (!Thread.currentThread().getName().equals("public-text-requalification")
                        || !line.equals("startup-audit failed: Content publication qualification is unresolved")) return;
                    auditing.countDown();
                    try {
                        if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("maintenance test did not release audit");
                    } catch (InterruptedException cancelled) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException("maintenance test audit interrupted", cancelled);
                    }
                };
                assertEquals("committed", fixture.deliver(1, "retained source during maintenance", "en").get("status"));
                assertTrue("Content maintenance did not start", auditing.await(5, TimeUnit.SECONDS));
                // The audit is still running. No owner witness exists in this
                // fixture, but both normal and captured physical reads qualify.
                var proof = SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0);
                assertEquals(proof.toString(), true, proof.get("available"));
                assertFalse(proof.containsKey("contentQualification"));
                try (var capture = SearchDeltaJournal.captureRead(fixture.data)) {
                    assertEquals(capture.qualification().toString(), true, capture.qualification().get("available"));
                    assertEquals("1", capture.qualification().get("qualifiedPopulation"));
                    assertFalse(capture.qualification().containsKey("contentQualification"));
                }
            } finally { release.countDown(); SearchDeltaJournal.logged = previous; }
        }
    }

    @Test public void verifiedDeliveryRetainsPhysicalProofWithoutInventingContentCompleteness() throws Exception {
        try (var fixture = new SearchDeltaJournalTest.ContentFixture()) {
            // This native delivery fixture has retained body receipts, but no
            // publication/eligibility owner receipts. It cannot issue Content
            // completeness, even when physical delivery is fully verified.
            assertEquals("committed", fixture.deliver(1, "first retained source", "en").get("status"));
            var before = SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0);
            assertEquals(before.toString(), true, before.get("available"));
            assertEquals("1", before.get("qualifiedPopulation"));
            assertNotNull(before.get("generation"));
            assertFalse(before.containsKey("contentQualification"));

            assertEquals("committed", fixture.deliver(2, "replacement retained source", "en").get("status"));
            var after = SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0);
            assertEquals(after.toString(), true, after.get("available"));
            assertEquals(before.get("generation"), after.get("generation"));
            assertEquals("1", after.get("qualifiedPopulation"));
            assertFalse(after.containsKey("contentQualification"));
            fixture.data.begin(ReadWrite.READ);
            try { FilteredGraphTextIndex.verifyContentBodyCommitted(fixture.data, SearchDeltaJournalTest.ContentFixture.UNIT_ID); }
            finally { fixture.data.end(); }
        }
    }
}
