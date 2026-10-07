package com.rezics.jena;

import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.HexFormat;
import java.util.Arrays;
import java.nio.charset.StandardCharsets;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.tdb2.store.NodeIdFactory;
import org.apache.jena.tdb2.store.tupletable.TupleIndexRecord;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Objects;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** O(declared current subjects), with one membership-head replacement per
 * affected publication subject. No dependent Statement/Context fan-out. */
final class StatementPublicationMembership {
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node CONTROL = uri(CommandPolicy.CONTROL);
    private static final Node ACTIVE = rv("Active");
    private static final Node MEMBERSHIP = rv("statementPublicationMembershipHead");
    private final DatasetGraph data;
    private final Map<Node, Potential> before = new LinkedHashMap<>();
    private record Potential(Node subject, Node head, Node source, boolean evidence) {}

    StatementPublicationMembership(DatasetGraph data, CommandPolicy.Plan plan) {
        this.data = data;
        for (String id : plan.current()) {
            Node statement = uri(id);
            before.put(statement, potential(statement));
        }
    }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String value) { return uri("https://rezics.com/vocab/" + value); }
    private Node one(Node graph, Node subject, Node predicate) {
        Node result = null;
        for (Node placement : graph.equals(CURRENT) ? List.of(CURRENT, Quad.defaultGraphNodeGenerated) : List.of(graph)) {
            var values = data.find(placement, subject, predicate, Node.ANY);
            try {
                int seen = 0;
                while (values.hasNext()) {
                    if (++seen > 2) throw new IllegalArgumentException("publication reference is ambiguous");
                    Node value = values.next().getObject();
                    if (result != null && !result.equals(value)) throw new IllegalArgumentException("publication reference is ambiguous");
                    result = value;
                }
            } finally { Iter.close(values); }
        }
        return result;
    }
    private Potential potential(Node statement) {
        if (!(data.contains(CURRENT, statement, RDF.type.asNode(), RDF.Statement.asNode())
              || data.contains(Quad.defaultGraphNodeGenerated, statement, RDF.type.asNode(), RDF.Statement.asNode()))) return null;
        Node state = one(CURRENT, statement, rv("statementState"));
        if (state == null) throw new IllegalArgumentException("publication reference is incomplete");
        if (!state.equals(ACTIVE)) {
            if (!state.equals(rv("Withdrawn"))) throw new IllegalArgumentException("publication reference state is malformed");
            return null;
        }
        Node subject = one(CURRENT, statement, RDF.subject.asNode());
        Node head = one(CURRENT, statement, rv("head"));
        Node source = one(CURRENT, statement, rv("source"));
        if (subject == null || !subject.isURI() || head == null || !head.isURI()
            || source != null && !source.isURI())
            throw new IllegalArgumentException("publication reference is incomplete");
        boolean evidence = data.contains(REVISIONS, head, rv("evidence"), Node.ANY);
        return source != null || evidence ? new Potential(subject, head, source, evidence) : null;
    }
    void advance(String receipt) {
        var changed = new LinkedHashSet<Node>();
        for (var entry : before.entrySet()) {
            Potential prior = entry.getValue(), next = potential(entry.getKey());
            if (Objects.equals(prior, next)) continue;
            if (prior != null) changed.add(prior.subject());
            if (next != null) changed.add(next.subject());
        }
        DatasetGraph observed = CommandWork.observe(data);
        for (Node subject : changed) {
            observed.deleteAny(CONTROL, subject, MEMBERSHIP, Node.ANY);
            observed.add(CONTROL, subject, MEMBERSHIP, uri(receipt));
        }
    }
    static final int MAX_TUPLES = 128, MAX_PROCESSED = 127, MAX_WITNESS_TUPLES = 8192, MAX_PAGE_BYTES = 256 * 1024;
    private static final String PROCESS = UUID.randomUUID().toString();
    private static final Map<org.apache.jena.tdb2.store.DatasetGraphTDB,String> STORES = new WeakHashMap<>();
    private static final Node PRODUCT = uri("urn:rezics:dataset:product"), GLOBAL = uri("urn:rezics:classification-context:global");
    private static final List<Node> CURRENT_PLACEMENTS = List.of(CURRENT, Quad.defaultGraphNodeGenerated);
    private record PageBasis(String dataEpoch, String routingEpoch, String subject, String membershipHead, String storage) {}
    private record Cursor(String storage, int phase, String key, String seal) {}
    private static final byte[] SEAL_KEY = new byte[32];
    static { new java.security.SecureRandom().nextBytes(SEAL_KEY); }
    private static final class PageWork {
        int tuples, bytes;
        final long deadline = System.nanoTime() + 10_000_000_000L;
        void check() {
            if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
                throw new IllegalArgumentException("publication page deadline expired");
        }
        void node(Node node) {
            check(); tuples++;
            if (tuples > MAX_WITNESS_TUPLES) throw new IllegalArgumentException("publication witness tuple bound exceeded");
            String text = node.isURI() ? node.getURI() : node.isLiteral() ? node.getLiteralLexicalForm() : node.toString();
            if (text.length() > 2048) throw new IllegalArgumentException("publication witness byte bound exceeded");
            int length = text.getBytes(StandardCharsets.UTF_8).length;
            if (length > 2048 || (bytes = Math.addExact(bytes,length)) > MAX_PAGE_BYTES)
                throw new IllegalArgumentException("publication witness byte bound exceeded");
        }
    }
    /** One fixed owner read. Continuation is TDB physical order, never SQL C order. */
    static Map<String,Object> read(DatasetGraph logical, JsonObject request) {
        if (!request.keys().equals(Set.of("operation","dataEpoch","routingEpoch","subject","membershipHead","after"))
            || !"statement-publication-page".equals(string(request,"operation")))
            throw new IllegalArgumentException("invalid closed publication page request");
        String epoch = string(request,"dataEpoch"), routing = string(request,"routingEpoch"), subject = string(request,"subject");
        String membership = request.get("membershipHead").isNull() ? null : string(request,"membershipHead");
        if (epoch.isEmpty() || epoch.indexOf(0)>=0 || epoch.length()>128 || !StandardCharsets.UTF_8.newEncoder().canEncode(epoch)
            || routing.isEmpty() || routing.indexOf(0)>=0 || routing.length()>128
            || !StandardCharsets.UTF_8.newEncoder().canEncode(routing) || routing.getBytes(StandardCharsets.UTF_8).length>128)
            throw new IllegalArgumentException("invalid publication lineage");
        pageNativeId(uri(subject)); if (membership != null) pageUri(uri(membership));
        boolean captureOnly = request.get("after").isString() && "basis".equals(request.get("after").getAsString().value());
        Cursor after = captureOnly ? null : cursor(request);
        DatasetGraph base = DatasetGraphWrapper.unwrap(logical);
        var tdb = TDBInternal.requireStorage(base);
        if (tdb.isInTransaction()) throw new IllegalArgumentException("publication page owns its read transaction");
        PageWork work = new PageWork();
        tdb.begin(ReadWrite.READ);
        try {
            String storage;
            synchronized (STORES) { storage = PROCESS + ":" + STORES.computeIfAbsent(tdb, ignored -> UUID.randomUUID().toString()); }
            PageBasis basis = new PageBasis(epoch,routing,subject,membership,storage);
            sourceBasis(tdb,basis,work);
            if (captureOnly) return pageResult(basis,null,false,0,work,List.of());
            if (after != null && !after.storage().equals(storage)) throw new IllegalArgumentException("publication physical cursor requires restart");
            if (after != null && !java.security.MessageDigest.isEqual(HexFormat.of().parseHex(after.seal()),
                HexFormat.of().parseHex(seal(basis,after.phase(),after.key()))))
                throw new IllegalArgumentException("publication physical cursor seal differs");
            int phase = after == null ? 0 : after.phase(); String last = after == null ? "" : after.key();
            int examined = 0, processed = 0;
            List<Map<String,Object>> references = new ArrayList<>();
            for (; phase < 2; phase++) {
                work.check();
                boolean named = phase == 0;
                var table = named ? tdb.getQuadTable().getNodeTupleTable() : tdb.getTripleTable().getNodeTupleTable();
                var index = (TupleIndexRecord) table.getTupleTable().selectIndex(named ? "GPOS" : "POS").baseTupleIndex();
                var factory = index.getRangeIndex().getRecordFactory();
                var start = factory.createKeyOnly(); var end = factory.createKeyOnly();
                Node[] prefix = named ? new Node[]{CURRENT,RDF.subject.asNode(),uri(subject)} : new Node[]{RDF.subject.asNode(),uri(subject)};
                boolean absent = false;
                for (int i=0;i<prefix.length;i++) {
                    var id = table.getNodeTable().getNodeIdForNode(prefix[i]);
                    if (org.apache.jena.tdb2.store.NodeId.isDoesNotExist(id)) { absent = true; break; }
                    NodeIdFactory.set(id,start.getKey(),i*8); NodeIdFactory.set(id,end.getKey(),i*8);
                }
                if (absent) {
                    if (!last.isEmpty()) throw new IllegalArgumentException("publication cursor prefix disappeared");
                    continue;
                }
                NodeIdFactory.setNext(table.getNodeTable().getNodeIdForNode(prefix[prefix.length-1]),end.getKey(),(prefix.length-1)*8);
                if (!last.isEmpty()) {
                    byte[] key = HexFormat.of().parseHex(last);
                    if (key.length != (named ? 32 : 24) || !Arrays.equals(Arrays.copyOf(key,prefix.length*8),Arrays.copyOf(start.getKey(),prefix.length*8)))
                        throw new IllegalArgumentException("publication physical cursor prefix differs");
                    System.arraycopy(key,0,start.getKey(),0,key.length); increment(start.getKey());
                }
                var tuples = index.getRangeIndex().iterator(start,end);
                try {
                    while (tuples.hasNext()) {
                        work.check(); var tuple = tuples.next(); examined++;
                        if (examined > MAX_TUPLES) throw new IllegalStateException("publication physical work bound exceeded");
                        if (processed == MAX_PROCESSED) {
                            Cursor next = new Cursor(storage,phase,last,seal(basis,phase,last));
                            return pageResult(basis,next,false,examined,work,references);
                        }
                        processed++; last = HexFormat.of().formatHex(tuple.getKey());
                        Node statement = table.getNodeTable().getNodeForNodeId(NodeIdFactory.get(tuple.getKey(),prefix.length*8));
                        Map<String,Object> reference = pageReference(tdb,statement,uri(subject),work);
                        if (reference != null) references.add(reference);
                    }
                } finally { Iter.close(tuples); }
                last = "";
            }
            // A phase-2 certificate is checked against incarnation and exact source basis on every fence.
            return pageResult(basis,new Cursor(storage,2,"",seal(basis,2,"")),true,examined,work,references);
        } finally { tdb.end(); }
    }
    private static Map<String,Object> pageResult(PageBasis basis, Cursor cursor, boolean complete, int examined, PageWork work, List<Map<String,Object>> references) {
        Map<String,Object> row = new LinkedHashMap<>();
        row.put("dataEpoch",basis.dataEpoch()); row.put("routingEpoch",basis.routingEpoch()); row.put("subject",basis.subject());
        row.put("membershipHead",basis.membershipHead() == null ? org.apache.jena.atlas.json.JsonNull.instance : basis.membershipHead()); row.put("storage",basis.storage());
        Map<String,Object> result = new LinkedHashMap<>();
        result.put("basis",row); result.put("after",cursor == null ? org.apache.jena.atlas.json.JsonNull.instance : Map.of("storage",cursor.storage(),"phase",cursor.phase(),"key",cursor.key(),"seal",cursor.seal()));
        result.put("complete",complete); result.put("examined",examined); result.put("witnessTuples",work.tuples); result.put("references",List.copyOf(references));
        if (CommandService.jsonObject(result).toString().getBytes(StandardCharsets.UTF_8).length > MAX_PAGE_BYTES)
            throw new IllegalArgumentException("publication response byte bound exceeded");
        return result;
    }
    private static Cursor cursor(JsonObject request) {
        if (request.get("after").isNull()) return null;
        JsonObject after = request.get("after").getAsObject();
        if (!after.keys().equals(Set.of("storage","phase","key","seal"))) throw new IllegalArgumentException("invalid publication cursor fields");
        String phaseText = after.get("phase").getAsNumber().value().toString();
        if (!phaseText.matches("[012]")) throw new IllegalArgumentException("invalid publication cursor phase");
        int phase = Integer.parseInt(phaseText); String key = string(after,"key"), storage = string(after,"storage");
        if (!storage.matches("[0-9a-f-]{36}:[0-9a-f-]{36}") || !key.matches(phase == 0 ? "(?:[0-9a-f]{64})?" : phase == 1 ? "(?:[0-9a-f]{48})?" : ""))
            throw new IllegalArgumentException("invalid publication cursor");
        String seal = string(after,"seal");
        if (!seal.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("invalid publication cursor seal");
        return new Cursor(storage,phase,key,seal);
    }
    /** Fixed operation token integrity; this grants no publication/disclosure authority. */
    private static String seal(PageBasis basis, int phase, String key) {
        try {
            var mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(SEAL_KEY,"HmacSHA256"));
            String message = String.join("\0",basis.dataEpoch(),basis.routingEpoch(),basis.subject(),
                basis.membershipHead() == null ? "" : basis.membershipHead(),basis.storage(),Integer.toString(phase),key);
            return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String string(JsonObject row, String key) { return row.get(key).getAsString().value(); }
    private static void pageUri(Node node) {
        if (node == null || !node.isURI() || node.getURI().isEmpty() || node.getURI().length()>2048 || node.getURI().getBytes(StandardCharsets.UTF_8).length>2048 || !StandardCharsets.UTF_8.newEncoder().canEncode(node.getURI())
            || !node.getURI().matches("[A-Za-z][A-Za-z0-9+.-]*:[^\\s\\p{Cntrl}<>\"{}|\\\\^`]+"))
            throw new IllegalArgumentException("publication witness is not a bounded IRI");
    }
    private static void pageNativeId(Node node) {
        pageUri(node);
        if (!node.getURI().matches("https://rezics\\.com/id/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"))
            throw new IllegalArgumentException("publication witness is not a native identity");
    }
    private static Node pageOne(DatasetGraph data, List<Node> graphs, Node subject, Node predicate, boolean required, PageWork work) {
        Node value = null;
        for (Node graph : graphs) {
            var rows = data.find(graph,subject,predicate,Node.ANY);
            try {
                if (rows.hasNext()) {
                    Node found = rows.next().getObject(); work.node(found);
                    if (value != null && !value.equals(found)) throw new IllegalArgumentException("publication witness aliases conflict");
                    value = found;
                    if (rows.hasNext()) { work.node(rows.next().getObject()); throw new IllegalArgumentException("publication witness is ambiguous"); }
                }
            } finally { Iter.close(rows); }
        }
        if (required && value == null) throw new IllegalArgumentException("publication witness is incomplete");
        return value;
    }
    private static boolean pageExists(DatasetGraph data, List<Node> graphs, Node subject, Node predicate, Node object, PageWork work) {
        for (Node graph : graphs) {
            var rows = data.find(graph,subject,predicate,object);
            try { if (rows.hasNext()) { work.node(rows.next().getObject()); return true; } }
            finally { Iter.close(rows); }
        }
        return false;
    }
    private static void sourceBasis(DatasetGraph data, PageBasis basis, PageWork work) {
        Node epoch = pageOne(data,List.of(CONTROL),PRODUCT,rv("dataEpoch"),true,work),
            routing = pageOne(data,List.of(CONTROL),PRODUCT,rv("routingEpoch"),true,work),
            held = pageOne(data,List.of(CONTROL),PRODUCT,rv("restoreHold"),false,work),
            head = pageOne(data,List.of(CONTROL),uri(basis.subject()),MEMBERSHIP,false,work);
        if (!epoch.isLiteral() || !routing.isLiteral() || !epoch.getLiteralLexicalForm().equals(basis.dataEpoch())
            || !routing.getLiteralLexicalForm().equals(basis.routingEpoch()) || held != null && (!held.isLiteral() || !Boolean.FALSE.equals(held.getLiteralValue()))
            || head != null && !head.isURI() || !Objects.equals(head == null ? null : head.getURI(),basis.membershipHead()))
            throw new IllegalArgumentException("publication source basis is unavailable or moved");
        if (pageExists(data,CURRENT_PLACEMENTS,GLOBAL,Node.ANY,Node.ANY,work))
            throw new IllegalArgumentException("publication channel requires no current Global facts");
    }
    private static Map<String,Object> pageReference(DatasetGraph data, Node statement, Node subject, PageWork work) {
        if (statement == null || !statement.isURI()) throw new IllegalArgumentException("publication statement identity is malformed");
        if (!pageExists(data,CURRENT_PLACEMENTS,statement,RDF.type.asNode(),RDF.Statement.asNode(),work)) return null;
        Node state = pageOne(data,CURRENT_PLACEMENTS,statement,rv("statementState"),true,work);
        if (!state.equals(ACTIVE)) {
            if (!state.equals(rv("Withdrawn"))) throw new IllegalArgumentException("publication Statement state is malformed");
            return null;
        }
        Node actualSubject = pageOne(data,CURRENT_PLACEMENTS,statement,RDF.subject.asNode(),true,work),
            predicate = pageOne(data,CURRENT_PLACEMENTS,statement,RDF.predicate.asNode(),true,work),
            key = pageOne(data,CURRENT_PLACEMENTS,statement,rv("meaningKey"),true,work),
            head = pageOne(data,CURRENT_PLACEMENTS,statement,rv("head"),true,work),
            source = pageOne(data,CURRENT_PLACEMENTS,statement,rv("source"),false,work);
        for (Node node : List.of(statement,actualSubject,head)) pageNativeId(node);
        for (Node node : List.of(predicate,key)) pageUri(node);
        if (!subject.equals(actualSubject) || !key.getURI().matches("urn:rezics:meaning:[0-9a-f]{64}"))
            throw new IllegalArgumentException("publication Statement reference is malformed");
        if (source != null) pageNativeId(source);
        boolean evidence = pageExists(data,List.of(REVISIONS),head,rv("evidence"),Node.ANY,work);
        if (source == null && !evidence) return null;
        var applications = new LinkedHashSet<String>();
        for (Node graph : CURRENT_PLACEMENTS) {
            var rows = data.find(graph,statement,rv("applicability"),Node.ANY);
            try {
                int seen = 0;
                while (rows.hasNext()) {
                    Node app = rows.next().getObject(); work.node(app); pageUri(app);
                    if (++seen>8 || applications.size()==8 && !applications.contains(app.getURI()))
                        throw new IllegalArgumentException("publication applicability exceeds bound");
                    applications.add(app.getURI());
                }
            } finally { Iter.close(rows); }
        }
        Map<String,Object> result = new LinkedHashMap<>();
        result.put("subject",subject.getURI()); result.put("predicate",predicate.getURI()); result.put("meaningKey",key.getURI());
        result.put("statementId",statement.getURI()); result.put("head",head.getURI()); result.put("source",source == null ? org.apache.jena.atlas.json.JsonNull.instance : source.getURI());
        result.put("hasEvidence",evidence); result.put("applicability",List.copyOf(applications));
        return result;
    }
    private static void increment(byte[] bytes) {
        for (int i=bytes.length-1;i>=0;i--) if (++bytes[i]!=0) return;
        throw new IllegalArgumentException("publication physical checkpoint overflow");
    }
}
