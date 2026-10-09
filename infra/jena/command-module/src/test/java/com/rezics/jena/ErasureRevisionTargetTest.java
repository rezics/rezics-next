package com.rezics.jena;

import static org.junit.Assert.*;

import org.junit.Test;

public class ErasureRevisionTargetTest {
    @Test public void tombstoneSubjectsAreContentUrnsOrRevisionIris() {
        String uuid = "00000000-0000-4000-8000-000000000001";
        assertTrue(("urn:rezics:content:revision:" + uuid).matches(ErasurePolicy.REVISION_TARGET));
        assertTrue(("https://rezics.com/id/" + uuid).matches(ErasurePolicy.REVISION_TARGET));
        assertFalse(("urn:rezics:work:revision:" + uuid).matches(ErasurePolicy.REVISION_TARGET));
    }
}
