import java.io.File;
import java.util.concurrent.atomic.AtomicReference;

import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.tdb2.DatabaseMgr;
import org.apache.jena.tdb2.sys.TDBInternal;

/**
 * TDB2 fixtures for the integrity tests, run against Jena 6.2.0 in the Fuseki image's class path.
 *
 * populate DIR            committed batches plus aborted ones that allocate many nodes
 * commit-failure DIR WHO  a component's state channel closes, then a commit runs (what an interrupted
 *                         write leaves behind); prints what a reader on another thread sees
 * reopen DIR              opens the store again (journal recovery) and prints what a reader sees
 *
 * Output is one JSON object on the last line.
 */
public class Tdb2Fixture {
    static final Node G = NodeFactory.createURI("urn:fixture:g");
    static final Node P = NodeFactory.createURI("urn:fixture:p");
    static final int BATCH = 200;
    static DatasetGraph data;

    static void add(String tag, int n) {
        for (int i = 0; i < n; i++)
            data.add(G, NodeFactory.createURI("urn:fixture:" + tag + ":s" + i), P,
                NodeFactory.createLiteralString("value-" + tag + "-" + i + "-" + "x".repeat(40)));
    }

    /** Reads on a new thread, as a request thread does: the writer's own thread sees its uncommitted cache. */
    static String read(String tag) {
        AtomicReference<String> out = new AtomicReference<>();
        Thread thread = new Thread(() -> {
            int found = 0;
            String error = "";
            data.begin(ReadWrite.READ);
            try {
                for (int i = 0; i < BATCH; i++) {
                    var it = data.find(G, NodeFactory.createURI("urn:fixture:" + tag + ":s" + i), Node.ANY, Node.ANY);
                    while (it.hasNext()) {
                        var quad = it.next();
                        found++;
                        if (!quad.getObject().getLiteralLexicalForm().startsWith("value-" + tag + "-" + i + "-"))
                            error = "wrong value " + quad;
                    }
                }
            } catch (Throwable t) {
                error = t.getClass().getSimpleName() + ": " + t.getMessage();
            } finally {
                data.end();
            }
            out.set("\"found\":" + found + ",\"readError\":" + quote(error));
        });
        thread.start();
        try { thread.join(); } catch (InterruptedException e) { throw new RuntimeException(e); }
        return out.get();
    }

    static String quote(String s) {
        return '"' + s.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }

    public static void main(String[] args) throws Exception {
        String mode = args[0];
        File dir = new File(args[1]);
        long journalBeforeOpen = new File(dir, "Data-0001/journal.jrnl").length();
        data = DatabaseMgr.connectDatasetGraph(dir.getPath());
        switch (mode) {
            case "populate" -> populate();
            case "commit-failure" -> commitFailure(dir, args[2]);
            case "reopen" -> reopen(journalBeforeOpen);
            default -> throw new IllegalArgumentException(mode);
        }
        System.exit(0);
    }

    static void populate() {
        for (int round = 0; round < 10; round++) {
            data.begin(ReadWrite.WRITE); add("keep" + round, BATCH); data.commit(); data.end();
            data.begin(ReadWrite.WRITE); add("gone" + round, 3000); data.abort(); data.end();
        }
        System.out.println("{\"populated\":10}");
    }

    static void commitFailure(File dir, String who) throws Exception {
        var tdb = TDBInternal.getDatasetGraphTDB(data);
        data.begin(ReadWrite.WRITE); add("base", BATCH); data.commit(); data.end();
        data.begin(ReadWrite.WRITE); add("t", BATCH);
        Object state;
        if (who.equals("nodes-data")) {
            var file = ((org.apache.jena.tdb2.store.nodetable.NodeTableTRDF)
                tdb.getQuadTable().getNodeTupleTable().getNodeTable().baseNodeTable()).getData();
            var field = file.getClass().getDeclaredField("fileState");
            field.setAccessible(true);
            state = field.get(file);
        } else {
            var index = (org.apache.jena.tdb2.store.tupletable.TupleIndexRecord) TDBInternal.findIndex(tdb, who).baseTupleIndex();
            var tree = (org.apache.jena.dboe.trans.bplustree.BPlusTree) index.getRangeIndex();
            var field = tree.getClass().getDeclaredField("stateManager");
            field.setAccessible(true);
            state = field.get(tree);
        }
        ((org.apache.jena.dboe.transaction.txn.StateMgrBase) state).getBufferChannel().close();
        String thrown = "";
        try { data.commit(); } catch (Throwable t) { thrown = t.getClass().getSimpleName(); }
        try { data.end(); } catch (Throwable ignore) { /* the transaction is already past use */ }
        long journal = new File(dir, "Data-0001/journal.jrnl").length();
        // The next writer queues behind a lock the failed commit never released.
        Thread next = new Thread(() -> { data.begin(ReadWrite.WRITE); add("after", 3); data.commit(); data.end(); });
        next.setDaemon(true);
        next.start();
        next.join(3000);
        System.out.println("{\"who\":" + quote(who) + ",\"commitThrew\":" + quote(thrown) + ",\"journalBytes\":" + journal
            + ",\"nextWriterBlocked\":" + next.isAlive() + "," + read("t") + "}");
    }

    static void reopen(long journalBeforeOpen) {
        System.out.println("{\"journalBytesBeforeOpen\":" + journalBeforeOpen + "," + read("t") + "}");
    }
}
