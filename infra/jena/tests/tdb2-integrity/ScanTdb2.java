import java.io.File;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import org.apache.jena.atlas.lib.Pair;
import org.apache.jena.atlas.lib.tuple.Tuple;
import org.apache.jena.graph.Node;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.tdb2.DatabaseMgr;
import org.apache.jena.tdb2.store.DatasetGraphTDB;
import org.apache.jena.tdb2.store.NodeId;
import org.apache.jena.tdb2.store.nodetable.NodeTable;
import org.apache.jena.tdb2.store.nodetupletable.NodeTupleTable;
import org.apache.jena.tdb2.store.tupletable.TupleIndex;
import org.apache.jena.tdb2.sys.TDBInternal;

/**
 * Read-only integrity scan of a TDB2 database directory (the folder holding Data-NNNN).
 * Run it on a copy: opening a TDB2 location takes its lock and may replay the journal.
 *
 * Checks: every index of the quad and triple tables holds the same tuples; every node
 * pointer lies inside the committed node data file; every pointer decodes, and the
 * decoded node maps back to the same pointer through the node-to-id index.
 *
 * Usage: java ScanTdb2.java &lt;database-dir&gt;   (classpath: Jena TDB2, e.g. fuseki-server.jar)
 * Prints one JSON object; exit status 1 when any damage was found.
 */
public class ScanTdb2 {
    static final int SAMPLES = 10;
    static final Map<String, Object> report = new TreeMap<>();
    static final List<String> samples = new ArrayList<>();
    static final List<String> orphanSamples = new ArrayList<>();
    static long damage = 0;

    static void damaged(String what) {
        damage++;
        if (samples.size() < SAMPLES * 5) samples.add(what);
    }

    public static void main(String[] args) throws Exception {
        File dir = new File(args[0]);
        File dataDir = latestData(dir);
        long nodeFile = new File(dataDir, "nodes-data.obj").length();
        report.put("location", dir.getPath());
        report.put("dataDirectory", dataDir.getName());
        report.put("nodeFileLength", nodeFile);
        // A journal that still holds entries means the owner stopped (or failed) between a commit
        // point and the end of the commit; opening the store replays it before this scan reads.
        report.put("journalBytesBeforeOpen", new File(dataDir, "journal.jrnl").length());

        org.apache.jena.sparql.core.DatasetGraph dsg = DatabaseMgr.connectDatasetGraph(dir.getPath());
        DatasetGraphTDB tdb = TDBInternal.getDatasetGraphTDB(dsg);
        dsg.begin(ReadWrite.READ);
        try {
            // The cache wrapper answers a node's id from the id it just decoded; only the base table checks the index.
            NodeTable nodes = tdb.getQuadTable().getNodeTupleTable().getNodeTable().baseNodeTable();
            BitSet referenced = new BitSet();
            scanTable("quads", tdb.getQuadTable().getNodeTupleTable(), referenced, nodeFile, true);
            scanTable("triples", tdb.getTripleTable().getNodeTupleTable(), referenced, nodeFile, false);
            checkPointers(nodes, referenced, nodeFile);
            countNodeTable(nodes, referenced);
        } finally {
            dsg.end();
        }
        report.put("damage", damage);
        report.put("samples", samples);
        System.out.println(json(report));
        System.exit(damage == 0 ? 0 : 1);
    }

    static File latestData(File dir) {
        File[] all = dir.listFiles((d, n) -> n.startsWith("Data-") && new File(d, n).isDirectory());
        if (all == null || all.length == 0) throw new IllegalArgumentException("no Data-NNNN under " + dir);
        File best = all[0];
        for (File f : all) if (f.getName().compareTo(best.getName()) > 0) best = f;
        return best;
    }

    static void scanTable(String label, NodeTupleTable table, BitSet referenced, long nodeFile, boolean collect) {
        TupleIndex[] indexes = table.getTupleTable().getIndexes();
        TupleIndex primary = indexes[0];
        Map<String, Object> out = new TreeMap<>();
        long primaryCount = 0;
        for (TupleIndex index : indexes) {
            long count = 0, missing = 0;
            boolean isPrimary = index == primary;
            for (Iterator<Tuple<NodeId>> it = index.all(); it.hasNext(); ) {
                Tuple<NodeId> t = it.next();
                count++;
                if (isPrimary) {
                    if (collect) for (int i = 0; i < t.len(); i++) mark(referenced, t.get(i));
                } else if (!primary.find(t).hasNext()) {
                    missing++;
                    damaged(label + ": " + index.getName() + " tuple absent from " + primary.getName() + " " + t);
                }
            }
            if (isPrimary) primaryCount = count;
            Map<String, Object> entry = new TreeMap<>();
            entry.put("tuples", count);
            if (!isPrimary) {
                entry.put("absentFromPrimary", missing);
                if (count != primaryCount) damaged(label + ": " + index.getName() + " holds " + count + " tuples, " + primary.getName() + " holds " + primaryCount);
            }
            out.put(index.getName(), entry);
        }
        report.put(label, out);
    }

    static void mark(BitSet referenced, NodeId id) {
        if (id != null && id.isPtr()) {
            long at = id.getPtrLocation();
            if (at > Integer.MAX_VALUE) { damaged("pointer beyond 2^31: " + id); return; }
            referenced.set((int) at);
        }
    }

    static void checkPointers(NodeTable nodes, BitSet referenced, long nodeFile) {
        long distinct = 0, beyond = 0, undecodable = 0, aliased = 0, maxPointer = 0;
        Map<String, Long> failures = new TreeMap<>();
        for (int at = referenced.nextSetBit(0); at >= 0; at = referenced.nextSetBit(at + 1)) {
            distinct++;
            maxPointer = at;
            if (at > nodeFile) {
                beyond++;
                damaged("pointer " + at + " is beyond the node file length " + nodeFile);
                continue;
            }
            NodeId id = pointer(at);
            Node node;
            try {
                node = nodes.getNodeForNodeId(id);
            } catch (RuntimeException ex) {
                undecodable++;
                failures.merge(ex.getClass().getSimpleName() + ": " + String.valueOf(ex.getMessage()).replaceAll("[0-9]+", "N"), 1L, Long::sum);
                damaged("pointer " + at + " does not decode: " + ex);
                continue;
            }
            if (node == null) { undecodable++; damaged("pointer " + at + " decodes to no node"); continue; }
            NodeId back = nodes.getNodeIdForNode(node);
            if (!id.equals(back)) {
                aliased++;
                damaged("pointer " + at + " decodes to " + node + " whose own id is " + back);
            }
        }
        Map<String, Object> out = new TreeMap<>();
        out.put("distinctPointers", distinct);
        out.put("maxPointer", maxPointer);
        out.put("beyondNodeFile", beyond);
        out.put("undecodable", undecodable);
        out.put("decodeToAnotherId", aliased);
        out.put("failureKinds", failures);
        report.put("pointers", out);
    }

    static NodeId pointer(long at) {
        return NodeId.createRaw(org.apache.jena.tdb2.store.NodeIdType.PTR, at);
    }

    static void countNodeTable(NodeTable nodes, BitSet referenced) {
        long total = 0, unreferenced = 0, mismatched = 0;
        try {
            for (Iterator<Pair<NodeId, Node>> it = nodes.all(); it.hasNext(); ) {
                Pair<NodeId, Node> p = it.next();
                total++;
                NodeId id = p.getLeft();
                if (id.isPtr() && !referenced.get((int) id.getPtrLocation())) unreferenced++;
                NodeId back = nodes.getNodeIdForNode(p.getRight());
                if (!id.equals(back)) {
                    // A referenced pointer is damage. An unreferenced one is dead weight: no quad
                    // reaches it, so it is counted and sampled, not reported as damage.
                    mismatched++;
                    if (id.isPtr() && referenced.get((int) id.getPtrLocation()))
                        damaged("referenced node table entry " + id + " " + p.getRight() + " maps to " + back);
                    else if (orphanSamples.size() < SAMPLES) orphanSamples.add(id + " " + p.getRight());
                }
            }
        } catch (RuntimeException ex) {
            damaged("node table walk stopped after " + total + " entries: " + ex);
        }
        Map<String, Object> out = new TreeMap<>();
        out.put("entries", total);
        out.put("unreferenced", unreferenced);
        out.put("nodeToIdMismatch", mismatched);
        out.put("nodeToIdMismatchSamples", orphanSamples);
        report.put("nodeTable", out);
    }

    @SuppressWarnings("unchecked")
    static String json(Object value) {
        if (value instanceof Map<?, ?> m) {
            StringBuilder b = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) b.append(',');
                first = false;
                b.append(json(String.valueOf(e.getKey()))).append(':').append(json(e.getValue()));
            }
            return b.append('}').toString();
        }
        if (value instanceof List<?> l) {
            StringBuilder b = new StringBuilder("[");
            for (int i = 0; i < l.size(); i++) { if (i > 0) b.append(','); b.append(json(l.get(i))); }
            return b.append(']').toString();
        }
        if (value instanceof Number || value instanceof Boolean) return String.valueOf(value);
        String s = String.valueOf(value);
        return '"' + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + '"';
    }
}
