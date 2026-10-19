package com.rezics.jena;

import static org.junit.Assert.*;
import org.apache.jena.query.ReadWrite;
import org.junit.Test;

public class ContentQualificationMaintenanceTest {
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
