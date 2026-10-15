package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.junit.Test;

public class RankedSnapshotTest {
    private static final String PHRASE = "Retainedgarden passage";
    private static final org.apache.jena.graph.Node BODY = NodeFactory.createURI("https://rezics.com/vocab/searchBody");
    private static final FilteredGraphTextIndex.RankScope SCOPE = new FilteredGraphTextIndex.RankScope(null, null, null, true);
    private static FilteredGraphTextIndex.RankAfter after(FilteredGraphTextIndex.RankPage page) {
        var hit = page.hits().getLast();
        return new FilteredGraphTextIndex.RankAfter(hit.id(), hit.score(), page.commit(), hit.document());
    }
    private static FilteredGraphTextIndex.RankPage page(RealmSearchSeekTest.Fixture f, FilteredGraphTextIndex.RankAfter after) {
        f.data.begin(ReadWrite.READ);
        try { return f.index.ranked(BODY, PHRASE, 1, after, f.data, SCOPE); }
        finally { f.data.end(); }
    }

    @Test public void writesAndMergesCannotMoveScoresOrDocumentPositionsInARetainedBasis() throws Exception {
        try (var f = new RealmSearchSeekTest.Fixture()) {
            for (int n = 0; n < 6; n++) f.owner(70000 + n * 10, false, false, PHRASE + " words".repeat(n), null);
            f.committed();
            var first = page(f, null);
            var expected = new ArrayList<>(first.hits());
            for (var current = first; current.more();) {
                current = page(f, after(current)); expected.addAll(current.hits());
            }
            var actual = new ArrayList<>(first.hits());
            var current = first;
            for (int n = 0; current.more(); n++) {
                assertTrue(n < 6);
                f.data.begin(ReadWrite.WRITE);
                f.owner(80000 + n * 10, false, false, PHRASE + " " + PHRASE, null); f.committed();
                f.index.lucene().getIndexWriter().forceMerge(1); f.index.commit();
                current = page(f, after(current)); actual.addAll(current.hits());
            }
            assertEquals(expected, actual);
            assertEquals(6, actual.stream().map(FilteredGraphTextIndex.RankHit::key).distinct().count());
        }
    }

    @Test public void expiryCannotBeExtendedByReplayOrRevivedByReopeningTheSameCommit() throws Exception {
        var clock = new AtomicLong(1_000_000);
        try (var f = new RealmSearchSeekTest.Fixture(clock::get)) {
            for (int n = 0; n < 3; n++) f.owner(90000 + n * 10, false, false, PHRASE, null);
            f.committed();
            var first = page(f, null);
            clock.addAndGet(FilteredGraphTextIndex.RANK_BASIS_TTL_MS - 1);
            var replay = page(f, after(first));
            assertEquals(first.expiresAt(), replay.expiresAt());
            clock.incrementAndGet();
            assertThrows(FilteredGraphTextIndex.RankRestart.class, () -> page(f, after(first)));
            var restarted = page(f, null);
            assertNotEquals(first.commit(), restarted.commit());
            assertEquals(first.hits(), restarted.hits());
            assertThrows(FilteredGraphTextIndex.RankRestart.class, () -> page(f, after(first)));
            // A deferred first page addresses the retained start, without
            // inventing a document anchor or reopening the latest writer cut.
            assertEquals(restarted.hits(), page(f, new FilteredGraphTextIndex.RankAfter(null, 0f, restarted.commit())).hits());
        }
    }

    @Test public void retentionAdmissionCannotEvictAnActiveTraversal() throws Exception {
        var clock = new AtomicLong(1_000_000);
        try (var f = new RealmSearchSeekTest.Fixture(clock::get)) {
            f.owner(100000, false, false, PHRASE, null);
            f.owner(100010, false, false, PHRASE, null); f.committed();
            var first = page(f, null);
            var expected = page(f, after(first));
            for (int n = 1; n <= FilteredGraphTextIndex.MAX_RANK_BASES; n++) {
                f.data.begin(ReadWrite.WRITE);
                f.owner(100020 + n * 10, false, false, PHRASE, null); f.committed();
                if (n < FilteredGraphTextIndex.MAX_RANK_BASES) page(f, null);
            }
            assertThrows(org.apache.jena.query.text.TextIndexException.class, () -> page(f, null));
            assertEquals(expected.hits(), page(f, after(first)).hits());
            clock.addAndGet(FilteredGraphTextIndex.RANK_BASIS_TTL_MS);
            assertNotEquals(first.commit(), page(f, null).commit());
            assertThrows(FilteredGraphTextIndex.RankRestart.class, () -> page(f, after(first)));
        }
    }

    @Test public void retainingARankNeverRetainsPublicationAuthority() throws Exception {
        try (var f = new RealmSearchSeekTest.Fixture()) {
            var owners = new ArrayList<RealmSearchSeekTest.Owner>();
            for (int n = 0; n < 3; n++) owners.add(f.owner(110000 + n * 10, false, false, PHRASE, null));
            f.committed();
            var first = page(f, null);
            var second = page(f, after(first));
            var revoked = owners.stream().filter(owner -> owner.unit().getURI().equals(second.hits().getFirst().id())).findFirst().orElseThrow();
            f.data.begin(ReadWrite.WRITE);
            f.data.deleteAny(NodeFactory.createURI(CommandPolicy.CURRENT), revoked.main(),
                NodeFactory.createURI("https://rezics.com/vocab/selectionHead"), org.apache.jena.graph.Node.ANY);
            f.committed();
            var continued = page(f, after(first));
            assertEquals(second.hits().getFirst().id(), continued.hits().getFirst().id());
            assertNull(continued.hits().getFirst().key());
            assertNotNull(page(f, after(continued)).hits().getFirst().key());
        }
    }
}
