package com.rezics.jena;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.security.MessageDigest;
import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.*;
import org.apache.jena.dboe.base.record.RecordFactory;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.riot.out.NodeFmtLib;
import org.apache.jena.sparql.core.*;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.tdb2.store.NodeIdFactory;
import org.apache.jena.tdb2.store.tupletable.TupleIndexRecord;
import org.apache.jena.vocabulary.RDF;

/** Fixed pre-conversion CURRENT Claim membership. No eligibility, effect or release authority. */
final class ClaimFoldInventory {
    private static final String RV="https://rezics.com/vocab/", PREFIX="urn:rezics:name-migration:claim-statement-fold:", CONTRACT="claim-fold-inventory-v1";
    private static final Node CURRENT=uri(CommandPolicy.CURRENT), CONTROL=uri(CommandPolicy.CONTROL), RECEIPTS=uri(CommandPolicy.RECEIPTS), STATE=uri(TemplateIndexService.STATE), PRODUCT=uri("urn:rezics:dataset:product");
    private static final Node TRUE=NodeFactory.createLiteralByValue(true,org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean);
    static final int MAX_TUPLES=128, MAX_ROWS=127, MAX_WITNESS_BYTES=2048, MAX_PAGE_BYTES=256*1024;
    private static final String PROCESS=UUID.randomUUID().toString(), MEMBERS="claim-fold-members-v1", ZERO="0".repeat(64);
    private static final byte[] MEMBER_KEY=new byte[32];
    static { new java.security.SecureRandom().nextBytes(MEMBER_KEY); }
    private static final Map<org.apache.jena.tdb2.store.DatasetGraphTDB,String> STORES=new WeakHashMap<>();
    record Job(String dataEpoch,String routingEpoch,String marker,String mapDigest,String job,String acquireReceipt) {}
    record Request(Job job,String attempt,int page,String previous,String requestId,long deadline) {}
    record Row(String claim,String head,String witness) {}
    record Result(String status,boolean sourceComplete,String attempt,int page,String next,String hash,long total,List<Row> rows,String sourceCut,String error) {}
    private record Checkpoint(String cut,String attempt,String storage,long version,String after,int page,long total,long count,String hash,String sourceCut,boolean sealed) {}
    private record Slice(List<Row> rows,String after,boolean eof) {}

    record DispositionRequest(Job job,String sourceCut,String seal,Row row,long deadline) {}
    record MembersRequest(Job job,String sourceCut,String seal,String progress,long deadline) {}
    private static final String RETAIN="claim-fold-retained-outside-publication-v1", RETAIN_PREFIX="urn:rezics:claim-fold-retained:";
    record RetainRequest(Job job,String sourceCut,String seal,Row row,String relationDefinition,String qualificationDefinition,
        String relationManifest,String relationPayload,String qualificationManifest,String qualificationPayload,long deadline) {}
    private record Construction(long count,String hash) {}

    private static JsonObject parseEnvelope(byte[] bytes,String member) {
        if(bytes.length>16*1024) throw new IllegalArgumentException("Claim inventory envelope exceeds 16 KiB");
        String text;
        try { text=StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString(); }
        catch(java.nio.charset.CharacterCodingException invalid) { throw new IllegalArgumentException("invalid Claim inventory UTF8",invalid); }
        // This fixed DTO has objects, strings and integer counters only. Atlas's
        // extended JSON grammar must not silently accept extra wire meanings.
        class Wire {
            int at;
            void ws() { while(at<text.length() && " \t\r\n".indexOf(text.charAt(at))>=0) at++; }
            boolean take(char ch) { ws(); if(at<text.length() && text.charAt(at)==ch) { at++; return true; } return false; }
            void need(char ch) { if(!take(ch)) throw new IllegalArgumentException("invalid Claim inventory JSON"); }
            String string() {
                ws(); int start=at; need('"');
                while(at<text.length()) {
                    char ch=text.charAt(at++);
                    if(ch=='"') return JSON.parse("{\"v\":"+text.substring(start,at)+"}").get("v").getAsString().value();
                    if(ch<32) throw new IllegalArgumentException("invalid Claim inventory string");
                    if(ch=='\\') {
                        if(at==text.length()) throw new IllegalArgumentException("truncated Claim inventory escape");
                        char escaped=text.charAt(at++);
                        if(escaped=='u') { for(int n=0;n<4;n++) if(at==text.length() || "0123456789abcdefABCDEF".indexOf(text.charAt(at++))<0) throw new IllegalArgumentException("invalid Claim inventory escape"); }
                        else if("\"\\/bfnrt".indexOf(escaped)<0) throw new IllegalArgumentException("invalid Claim inventory escape");
                    }
                }
                throw new IllegalArgumentException("truncated Claim inventory string");
            }
            JsonValue value(int depth) {
                ws(); if(at==text.length() || depth>3) throw new IllegalArgumentException("invalid Claim inventory value");
                if(text.charAt(at)=='{') {
                    at++; JsonObject object=new JsonObject(); if(take('}')) return object;
                    do { String key=string(); if(object.get(key)!=null) throw new IllegalArgumentException("duplicate Claim inventory field"); need(':'); object.put(key,value(depth+1)); } while(take(',')); need('}'); return object;
                }
                if(text.charAt(at)=='"') return new JsonString(string());
                var number=java.util.regex.Pattern.compile("-?(?:0|[1-9][0-9]*)").matcher(text).region(at,text.length());
                if(!number.lookingAt()) throw new IllegalArgumentException("Claim inventory requires integer counters");
                at=number.end(); JsonObject scalar=new JsonObject(); scalar.put("v",Long.parseLong(number.group())); return scalar.get("v");
            }
        }
        Wire wire=new Wire(); JsonObject envelope=wire.value(0).getAsObject(); wire.ws();
        if(wire.at!=text.length() || !envelope.keys().equals(Set.of(member))) throw new IllegalArgumentException("invalid Claim maintenance envelope");
        return envelope.get(member).getAsObject();
    }
    private static Job parseJob(JsonObject job) {
        if(!job.keys().equals(Set.of("dataEpoch","routingEpoch","marker","mapDigest","job","acquireReceipt"))) throw new IllegalArgumentException("invalid Claim inventory job fields");
        return new Job(s(job,"dataEpoch"),s(job,"routingEpoch"),s(job,"marker"),s(job,"mapDigest"),s(job,"job"),s(job,"acquireReceipt"));
    }
    static Request parse(byte[] bytes) {
        JsonObject request=parseEnvelope(bytes,"claimFoldInventory");
        if(!request.keys().equals(Set.of("job","attempt","page","previous","requestId","deadline"))) throw new IllegalArgumentException("invalid Claim inventory fields");
        Request result;
        try { result=new Request(parseJob(request.get("job").getAsObject()),s(request,"attempt"),Math.toIntExact(n(request,"page")),e(request,"previous"),s(request,"requestId"),n(request,"deadline")); }
        catch(ArithmeticException invalid) { throw new IllegalArgumentException("Claim inventory integer counter out of range",invalid); }
        validate(result); return result;
    }
    static JsonObject json(Result result) { JsonObject payload=resultJson(result); if(result.error()!=null) payload.put("error",result.error()); return payload; }

    /** Native registration gates ALL new same-job converts, including the old
     * explicit-partial caller path. Exact historical replay is handled ahead of it. */
    static String conversionGate(DatasetGraph logical,CommandPolicy.Plan plan,String receipt,long commandDeadline) {
        if(!receipt.matches(PREFIX+"convert:[0-9a-f]{64}")) return null;
        try {
            DatasetGraph data=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
            var modify=(org.apache.jena.sparql.modify.request.UpdateModify)plan.request().getOperations().getFirst();
            Node own=uri(receipt), marker=ownField(modify,own,"claimStatementFold");
            Checkpoint state=checkpoint(data,uri(marker.getURI()+":inventory"));
            if(state==null) return null; // accepted unregistered explicit jobs retain their behavior
            if(!state.sealed()) return "registered Claim inventory is not sealed";
            if(!state.storage().equals(incarnation(data)) || expectedVersion(data,headerFromMarker(marker),state)!=version(data)) return "Claim inventory conversion cut advanced; disposition reconciliation required";
            Clock clock=Clock.systemUTC(); long deadline=wallDeadline(commandDeadline,clock);
            Job identity=conversionJob(data,modify,own);
            if(!sealed(data,identity,state,state.sourceCut(),state.hash(),deadline,clock)) return "Claim inventory exact source cut is unavailable";
            if(!record(data,STATE,classifiedId(header(identity)),1,8192).isEmpty()) return "Claim inventory classification is sealed; no new dispositions";
            Node claim=ownField(modify,own,"convertedClaim"), head=ownField(modify,own,"sourceClaimRevision");
            if(!record(data,STATE,retainedId(identity,claim),1,4096).isEmpty()) return "Claim inventory C already retained";
            if(!record(data,STATE,dispositionId(identity,claim),1,4096).isEmpty()) return "Claim inventory C already converted; exact receipt replay required";
            Row current=witness(data,claim);
            if(!head.isURI() || !current.head().equals(head.getURI()) || !member(data,identity,current)) return "Claim inventory exact C/head witness differs";
            return null;
        } catch(InventoryDeadline expired) { return "Claim inventory deadline expired"; }
        catch(IllegalArgumentException invalid) { return "Claim inventory gate: "+invalid.getMessage(); }
    }
    private static Node ownField(org.apache.jena.sparql.modify.request.UpdateModify modify,Node receipt,String predicate) {
        List<Node> values=modify.getInsertQuads().stream().filter(quad->quad.getGraph().equals(RECEIPTS) && quad.getSubject().equals(receipt) && quad.getPredicate().equals(p(predicate))).map(Quad::getObject).toList();
        if(values.size()!=1) throw new IllegalArgumentException("Claim inventory receipt field differs"); return values.getFirst();
    }

    private static long wallDeadline(long commandDeadline,Clock clock) {
        return clock.millis()+Math.min(30_000,Math.max(0,(commandDeadline-System.nanoTime())/1_000_000));
    }
    private static Node headerFromMarker(Node marker) {
        if(!marker.isURI()) throw new IllegalArgumentException("Claim inventory marker differs"); return uri(marker.getURI()+":inventory");
    }
    private static Job conversionJob(DatasetGraph data,org.apache.jena.sparql.modify.request.UpdateModify modify,Node own) {
        var control=CommandInvariant.readControl(data); if(control==null) throw new IllegalArgumentException("Claim inventory held lineage unavailable");
        Node marker=ownField(modify,own,"claimStatementFold"); headerFromMarker(marker);
        String epoch=text(ownField(modify,own,"dataEpoch")), routing=text(control.routing()), map=text(ownField(modify,own,"foldMapDigest")), job=text(ownField(modify,own,"claimFoldJob"));
        String fence="{\"marker\":"+q(marker.getURI())+",\"mapDigest\":"+q(map)+",\"job\":"+q(job)+"}";
        return new Job(epoch,routing,marker.getURI(),map,job,PREFIX+"acquire:"+hash("[\"claim-statement-fold-v1\",\"acquire\","+q(epoch)+","+q(routing)+","+fence+"]"));
    }
    private static Node dispositionId(Job job,Node claim) { return uri(header(job).getURI()+":converted:"+hash(claim.getURI())); }
    private static Node progressId(Node header) { return uri(header.getURI()+":conversions"); }
    private static long expectedVersion(DatasetGraph data,Node header,Checkpoint state) { return expectedVersion(data,header,state,true); }
    private static long expectedVersion(DatasetGraph data,Node header,Checkpoint state,boolean fresh) {
        Set<Quad> fields=record(data,STATE,progressId(header),1,4096);
        if(fields.isEmpty()) return state.version();
        JsonObject progress=JSON.parse(text(value(fields,p("claimFoldConversionCheckpoint"))));
        if(!progress.keys().equals(Set.of("sourceCut","seal","attempt","storage","version","claim","receipt"))
            || !s(progress,"sourceCut").equals(state.sourceCut()) || !s(progress,"seal").equals(state.hash())
            || !s(progress,"attempt").equals(state.attempt()) || !s(progress,"storage").equals(state.storage()) || n(progress,"version")<=state.version()) throw new IllegalArgumentException("Claim disposition checkpoint differs");
        if(s(progress,"receipt").startsWith(SEALED_PREFIX)) {
            JsonObject marker=classification(data,header,state,fresh);
            if(marker==null || !e(progress,"claim").isEmpty() || !s(marker,"receipt").equals(s(progress,"receipt")) || number(marker,"version")!=n(progress,"version")) throw new IllegalArgumentException("Claim classification checkpoint differs");
            return n(progress,"version");
        }
        if(!nativeId(uri(s(progress,"claim")))) throw new IllegalArgumentException("Claim disposition checkpoint differs");
        boolean retained=s(progress,"receipt").startsWith(RETAIN_PREFIX);
        Node identity=uri(header.getURI()+(retained?":retained:":":converted:")+hash(s(progress,"claim")));
        JsonObject last=retained?retainedDisposition(data,identity,state):disposition(data,identity,state);
        if(last==null || !s(last,"claim").equals(s(progress,"claim")) || !s(last,"receipt").equals(s(progress,"receipt"))) throw new IllegalArgumentException("Claim disposition checkpoint receipt unavailable");
        return n(progress,"version");
    }
    private static JsonObject disposition(DatasetGraph data,Node identity,Checkpoint state) {
        Set<Quad> fields=record(data,STATE,identity,1,4096); if(fields.isEmpty()) return null;
        JsonObject row=JSON.parse(text(value(fields,p("claimFoldDisposition"))));
        if(!row.keys().equals(Set.of("status","sourceCut","seal","attempt","storage","claim","head","witness","receipt","digest","templateDigest","statementRevision"))
            || !s(row,"status").equals("converted") || !s(row,"sourceCut").equals(state.sourceCut()) || !s(row,"seal").equals(state.hash())
            || !s(row,"attempt").equals(state.attempt()) || !s(row,"storage").equals(state.storage())
            || !nativeId(uri(s(row,"claim"))) || !nativeId(uri(s(row,"head"))) || !nativeId(uri(s(row,"statementRevision")))
            || !s(row,"witness").matches("[0-9a-f]{64}") || !s(row,"digest").matches("[0-9a-f]{64}") || !s(row,"templateDigest").matches("[0-9a-f]{64}")
            || !s(row,"receipt").equals(PREFIX+"convert:"+s(row,"digest"))) throw new IllegalArgumentException("invalid native Claim disposition");
        return row;
    }
    /** Called only after the fixed policy's exact pre/poststate, immutable receipt
     * and blob validation, inside the same native writer transaction. */
    static String stageConverted(DatasetGraph logical,CommandPolicy.Plan plan,String receipt,String update,long commandDeadline) {
        if(!receipt.matches(PREFIX+"convert:[0-9a-f]{64}")) return null;
        try {
            DatasetGraph data=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
            if(!data.isInTransaction() || data.transactionMode()!=ReadWrite.WRITE) throw new IllegalArgumentException("Claim disposition requires native writer");
            var modify=(org.apache.jena.sparql.modify.request.UpdateModify)plan.request().getOperations().getFirst(); Node own=uri(receipt);
            Job job=conversionJob(data,modify,own); Checkpoint state=checkpoint(data,header(job));
            if(state==null) return null; // historical partial jobs do not acquire exhaustive authority
            Clock clock=Clock.systemUTC(); long deadline=wallDeadline(commandDeadline,clock);
            if(!sealed(data,job,state,state.sourceCut(),state.hash(),deadline,clock)) return "Claim disposition source cut advanced";
            if(!record(data,STATE,classifiedId(header(job)),1,8192).isEmpty()) return "Claim disposition classification is sealed; no new dispositions";
            Node claim=ownField(modify,own,"convertedClaim"),head=ownField(modify,own,"sourceClaimRevision");
            Row original=witness(data,claim,uri(CommandPolicy.REVISIONS));
            if(!original.head().equals(head.getURI()) || !member(data,job,original)) return "Claim disposition original witness differs";
            Node identity=dispositionId(job,claim);
            if(!record(data,STATE,retainedId(job,claim),1,4096).isEmpty()) return "Claim disposition conflicts with immutable retention";
            if(!record(data,STATE,identity,1,4096).isEmpty()) return "Claim disposition is immutable; exact receipt replay required";
            JsonObject row=new JsonObject(); row.put("status","converted"); row.put("sourceCut",state.sourceCut()); row.put("seal",state.hash()); row.put("attempt",state.attempt()); row.put("storage",state.storage());
            row.put("claim",original.claim()); row.put("head",original.head()); row.put("witness",original.witness()); row.put("receipt",receipt); row.put("digest",receipt.substring(receipt.lastIndexOf(':')+1));
            row.put("templateDigest",ClaimStatementFoldPolicy.templateDigest(update)); row.put("statementRevision",ownField(modify,own,"statementRevision").getURI());
            String bytes=JSON.toStringFlat(row); if(bytes.getBytes(StandardCharsets.UTF_8).length>4096) return "Claim disposition exceeds byte bound";
            logical.add(STATE,identity,p("claimFoldDisposition"),literal(bytes));
            JsonObject progress=new JsonObject(); progress.put("sourceCut",state.sourceCut()); progress.put("seal",state.hash()); progress.put("attempt",state.attempt()); progress.put("storage",state.storage());
            progress.put("version",Math.addExact(version(data),1)); progress.put("claim",original.claim()); progress.put("receipt",receipt);
            logical.deleteAny(STATE,progressId(header(job)),p("claimFoldConversionCheckpoint"),Node.ANY);
            logical.add(STATE,progressId(header(job)),p("claimFoldConversionCheckpoint"),literal(JSON.toStringFlat(progress)));
            return null;
        } catch(InventoryDeadline expired) { return "Claim disposition deadline expired"; }
        catch(IllegalArgumentException invalid) { return "Claim disposition: "+invalid.getMessage(); }
    }
    static DispositionRequest parseDisposition(byte[] bytes) {
        JsonObject request=parseEnvelope(bytes,"claimFoldDisposition");
        if(!request.keys().equals(Set.of("job","sourceCut","seal","claim","head","witness","deadline"))) throw new IllegalArgumentException("invalid Claim disposition fields");
        Job job=parseJob(request.get("job").getAsObject()); Row row=new Row(s(request,"claim"),s(request,"head"),s(request,"witness")); long deadline=n(request,"deadline");
        validate(new Request(job,"00000000-0000-0000-0000-000000000000",0,"","00000000-0000-0000-0000-000000000000",deadline));
        if(!nativeId(uri(row.claim())) || !nativeId(uri(row.head())) || !row.witness().matches("[0-9a-f]{64}") || !s(request,"sourceCut").matches("[0-9a-f]{64}") || !s(request,"seal").matches("[0-9a-f]{64}")) throw new IllegalArgumentException("invalid Claim disposition identity");
        return new DispositionRequest(job,s(request,"sourceCut"),s(request,"seal"),row,deadline);
    }
    /** One immutable native per-C result. Missing or refused reads carry no
     * terminal authority for owner errors, eligibility or completion. */
    static JsonObject readDisposition(DatasetGraph logical,DispositionRequest request) {
        Clock clock=Clock.systemUTC(); long deadline=Math.min(request.deadline(),clock.millis()+30_000);
        DatasetGraph data=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
        if(data.isInTransaction()) throw new IllegalArgumentException("Claim disposition owns its read transaction");
        try { deadline(deadline,clock); } catch(InventoryDeadline expired) { return dispositionStatus("deadline","Claim disposition deadline expired"); }
        data.begin(ReadWrite.READ);
        try {
            deadline(deadline,clock); Checkpoint state=checkpoint(data,header(request.job())); deadline(deadline,clock);
            if(state==null || !sealed(data,request.job(),state,request.sourceCut(),request.seal(),deadline,clock) || !member(data,request.job(),request.row())) return dispositionStatus("invalid","Claim disposition source proof differs");
            deadline(deadline,clock); JsonObject row=disposition(data,dispositionId(request.job(),uri(request.row().claim())),state); deadline(deadline,clock);
            JsonObject retained=retainedDisposition(data,retainedId(request.job(),uri(request.row().claim())),state);
            if(retained!=null) {
                if(row!=null || !s(retained,"claim").equals(request.row().claim()) || !s(retained,"head").equals(request.row().head()) || !s(retained,"witness").equals(request.row().witness())) return dispositionStatus("invalid","overlapping/mismatched retained disposition");
                verifyRetentionReceipt(data,request.job(),retained); deadline(deadline,clock); return retained;
            }
            if(row==null) return dispositionStatus("unresolved",null);
            if(!s(row,"claim").equals(request.row().claim()) || !s(row,"head").equals(request.row().head()) || !s(row,"witness").equals(request.row().witness())) return dispositionStatus("invalid","Claim disposition witness differs");
            // The fixed writer already validated immutable receipt/blob bytes. The
            // unchanged physical-version chain protects them; read only these
            // exact bounded scalar proof terms, never the six sealed RDF blobs.
            Map<Node,Node> exact=Map.ofEntries(Map.entry(RDF.type.asNode(),p("OperationReceipt")),Map.entry(p("commandFamily"),literal("claim-statement-fold-convert-v1")),
                Map.entry(p("datasetId"),PRODUCT),Map.entry(p("dataEpoch"),literal(request.job().dataEpoch())),Map.entry(p("sequence"),one(data,CONTROL,PRODUCT,p("sequence"),true)),Map.entry(p("convertedClaim"),uri(request.row().claim())),Map.entry(p("sourceClaimRevision"),uri(request.row().head())),Map.entry(p("statementRevision"),uri(s(row,"statementRevision"))),
                Map.entry(p("claimStatementFold"),uri(request.job().marker())),Map.entry(p("foldMapDigest"),literal(request.job().mapDigest())),Map.entry(p("claimFoldJob"),literal(request.job().job())),
                Map.entry(p("requestDigest"),literal(s(row,"digest"))),Map.entry(p("claimFoldTemplateDigest"),literal(s(row,"templateDigest"))),Map.entry(p("outcome"),p("Succeeded")));
            for(var entry:exact.entrySet()) {
                deadline(deadline,clock); Node actual=one(data,RECEIPTS,uri(s(row,"receipt")),entry.getKey(),true);
                scalarBytes(actual,MAX_WITNESS_BYTES); deadline(deadline,clock);
                if(!actual.equals(entry.getValue())) return dispositionStatus("invalid","Claim disposition native receipt differs");
            }
            deadline(deadline,clock); return row;
        } catch(InventoryDeadline expired) { return dispositionStatus("deadline","Claim disposition deadline expired"); }
        catch(IllegalArgumentException invalid) { return dispositionStatus("invalid",invalid.getMessage()); }
        finally { data.end(); }
    }
    private static JsonObject dispositionStatus(String status,String error) { JsonObject row=new JsonObject(); row.put("status",status); if(error!=null) row.put("error",error); return row; }

    private static Node retainedId(Job job,Node claim) { return uri(header(job).getURI()+":retained:"+hash(claim.getURI())); }
    static RetainRequest parseRetain(byte[] bytes) {
        JsonObject row=parseEnvelope(bytes,"claimFoldRetain");
        if(!row.keys().equals(Set.of("job","sourceCut","seal","claim","head","witness","relationDefinition","qualificationDefinition","relationManifest","relationPayload","qualificationManifest","qualificationPayload","deadline"))) throw new IllegalArgumentException("invalid fixed retained fields");
        RetainRequest request=new RetainRequest(parseJob(row.get("job").getAsObject()),s(row,"sourceCut"),s(row,"seal"),new Row(s(row,"claim"),s(row,"head"),s(row,"witness")),
            s(row,"relationDefinition"),s(row,"qualificationDefinition"),e(row,"relationManifest"),e(row,"relationPayload"),e(row,"qualificationManifest"),e(row,"qualificationPayload"),n(row,"deadline"));
        validate(new Request(request.job(),"00000000-0000-0000-0000-000000000000",0,"","00000000-0000-0000-0000-000000000000",request.deadline()));
        if(!nativeId(uri(request.row().claim())) || !nativeId(uri(request.row().head())) || !nativeId(uri(request.relationDefinition())) || !nativeId(uri(request.qualificationDefinition()))
            || !request.sourceCut().matches("[0-9a-f]{64}") || !request.seal().matches("[0-9a-f]{64}") || !request.row().witness().matches("[0-9a-f]{64}")) throw new IllegalArgumentException("invalid retained source identity");
        return request;
    }
    private static String retainDigest(RetainRequest request) {
        return hash(RETAIN+"\n"+JSON.toStringFlat(retainInput(request)));
    }
    private static JsonObject retainInput(RetainRequest request) {
        JsonObject row=requestJson(new Request(request.job(),"00000000-0000-0000-0000-000000000000",0,"","00000000-0000-0000-0000-000000000000",1));
        for(String key:List.of("contract","attempt","page","previous","requestId","deadline")) row.remove(key);
        row.put("sourceCut",request.sourceCut()); row.put("seal",request.seal()); row.put("claim",request.row().claim()); row.put("head",request.row().head()); row.put("witness",request.row().witness());
        row.put("relationDefinition",request.relationDefinition()); row.put("qualificationDefinition",request.qualificationDefinition()); row.put("relationManifest",request.relationManifest()); row.put("relationPayload",request.relationPayload());
        row.put("qualificationManifest",request.qualificationManifest()); row.put("qualificationPayload",request.qualificationPayload()); return row;
    }
    private static JsonObject retainedDisposition(DatasetGraph data,Node identity,Checkpoint state) {
        Set<Quad> fields=record(data,STATE,identity,1,4096); if(fields.isEmpty()) return null;
        JsonObject row=JSON.parse(text(value(fields,p("claimFoldRetainedDisposition"))));
        if(state==null || !row.keys().equals(Set.of("status","contract","sourceCut","seal","attempt","storage","claim","head","witness","predicate","sourceDigest","sourceReceipt","receipt","digest"))
            || !s(row,"status").equals("retained") || !s(row,"contract").equals(RETAIN) || !s(row,"sourceCut").equals(state.sourceCut()) || !s(row,"seal").equals(state.hash()) || !s(row,"attempt").equals(state.attempt()) || !s(row,"storage").equals(state.storage())
            || !nativeId(uri(s(row,"claim"))) || !nativeId(uri(s(row,"head"))) || !s(row,"witness").matches("[0-9a-f]{64}") || !s(row,"sourceDigest").matches("[0-9a-f]{64}")
            || !s(row,"digest").matches("[0-9a-f]{64}") || !s(row,"receipt").equals(RETAIN_PREFIX+s(row,"digest")) || s(row,"predicate").equals("https://schema.org/datePublished")
            || !s(row,"sourceReceipt").matches("urn:rezics:receipt:[0-9a-f]{64}")) throw new IllegalArgumentException("invalid native retained disposition"); return row;
    }
    private static void verifyRetentionReceipt(DatasetGraph data,Job job,JsonObject row) {
        Map<Node,Node> expected=retentionReceipt(data,job,row);
        if(!record(data,RECEIPTS,uri(s(row,"receipt")),expected.size(),8192).equals(expected.entrySet().stream().map(entry->new Quad(RECEIPTS,uri(s(row,"receipt")),entry.getKey(),entry.getValue())).collect(java.util.stream.Collectors.toSet()))) throw new IllegalArgumentException("exact retained native receipt differs");
    }
    private static Map<Node,Node> retentionReceipt(DatasetGraph data,Job job,JsonObject row) {
        return Map.ofEntries(Map.entry(RDF.type.asNode(),p("OperationReceipt")),Map.entry(p("commandFamily"),literal(RETAIN)),Map.entry(p("requestDigest"),literal(s(row,"digest"))),Map.entry(p("outcome"),p("Succeeded")),
            Map.entry(p("datasetId"),PRODUCT),Map.entry(p("dataEpoch"),literal(job.dataEpoch())),Map.entry(p("sequence"),one(data,RECEIPTS,uri(job.acquireReceipt()),p("sequence"),true)),
            Map.entry(p("claimStatementFold"),uri(job.marker())),Map.entry(p("foldMapDigest"),literal(job.mapDigest())),Map.entry(p("claimFoldJob"),literal(job.job())),
            Map.entry(p("retainedClaim"),uri(s(row,"claim"))),Map.entry(p("sourceClaimRevision"),uri(s(row,"head"))),Map.entry(p("sourceClaimReceipt"),uri(s(row,"sourceReceipt"))),Map.entry(p("sourceDigest"),literal(s(row,"sourceDigest"))),
            Map.entry(p("claimFoldSourceCut"),literal(s(row,"sourceCut"))),Map.entry(p("claimFoldInventorySeal"),literal(s(row,"seal"))),Map.entry(p("claimFoldSourceWitness"),literal(s(row,"witness"))),Map.entry(p("propositionPredicate"),uri(s(row,"predicate"))));
    }
    /** Fixed original-member retention. No caller reason/verdict or negative
     * preparation result can publish a native terminal disposition. */
    static JsonObject retain(DatasetGraph logical,RetainRequest request,ProfileRegistry profiles,java.util.concurrent.atomic.AtomicLong publicWriteEpoch) {
        Clock clock=Clock.systemUTC(); long entry=clock.millis()+30_000, deadline=Math.min(entry,request.deadline());
        DatasetGraph data=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
        if(data.isInTransaction()) throw new IllegalArgumentException("retention owns its maintenance transaction");
        String digest=retainDigest(request); Node identity=retainedId(request.job(),uri(request.row().claim()));
        try { deadline(entry,clock); } catch(InventoryDeadline expired) { return dispositionStatus("deadline","retention deadline expired"); }
        logical.begin(ReadWrite.READ);
        try {
            deadline(entry,clock); Checkpoint state=checkpoint(data,header(request.job()));
            JsonObject old=retainedDisposition(data,identity,state); deadline(entry,clock);
            if(old!=null && s(old,"digest").equals(digest) && s(old,"claim").equals(request.row().claim()) && s(old,"head").equals(request.row().head()) && s(old,"witness").equals(request.row().witness())) { verifyRetentionReceipt(data,request.job(),old); deadline(entry,clock); return old; }
            if(old!=null) return dispositionStatus("unresolved","immutable retained input differs");
        } catch(InventoryDeadline expired) { return dispositionStatus("deadline","retention deadline expired"); }
        catch(IllegalArgumentException invalid) { return dispositionStatus("unresolved",invalid.getMessage()); }
        finally { logical.end(); }
        try { deadline(deadline,clock); } catch(InventoryDeadline expired) { return dispositionStatus("deadline","retention deadline expired"); }
        synchronized(logical) {
        try { deadline(deadline,clock); } catch(InventoryDeadline expired) { return dispositionStatus("deadline","retention deadline expired"); }
        logical.begin(ReadWrite.WRITE); boolean committed=false, tracksIndex=false;
        try {
            deadline(deadline,clock); Checkpoint state=checkpoint(data,header(request.job())); JsonObject old=retainedDisposition(data,identity,state); deadline(deadline,clock);
            if(old!=null && s(old,"digest").equals(digest) && s(old,"claim").equals(request.row().claim()) && s(old,"head").equals(request.row().head()) && s(old,"witness").equals(request.row().witness())) { verifyRetentionReceipt(data,request.job(),old); return old; }
            if(old!=null || !sealed(data,request.job(),state,request.sourceCut(),request.seal(),deadline,clock)) return dispositionStatus("unresolved","retained source cut/version unavailable");
            directorySeal(data,request.job(),state); deadline(deadline,clock);
            if(!record(data,STATE,classifiedId(header(request.job())),1,8192).isEmpty()) return dispositionStatus("unresolved","classified job accepts no new dispositions");
            if(!record(data,STATE,dispositionId(request.job(),uri(request.row().claim())),1,4096).isEmpty()) return dispositionStatus("unresolved","converted member cannot be retained");
            if(!record(data,RECEIPTS,uri(RETAIN_PREFIX+digest),19,8192).isEmpty()) return dispositionStatus("unresolved","orphan/foreign retained receipt exists");
            Row source=witness(data,uri(request.row().claim()));
            if(!source.equals(request.row()) || !member(data,request.job(),source)) return dispositionStatus("unresolved","original retained witness differs");
            var proof=ClaimStatementFoldPolicy.captureRetention(data,uri(source.claim()),uri(source.head()),request.job().mapDigest(),uri(request.relationDefinition()),uri(request.qualificationDefinition()),request.relationManifest(),request.relationPayload(),request.qualificationManifest(),request.qualificationPayload());
            deadline(deadline,clock); if(proof.snapshot().error()!=null) return dispositionStatus("unresolved",proof.snapshot().error());
            for(var focus:List.of(Map.entry("claim",source.claim()),Map.entry("revision",source.head()))) {
                deadline(deadline,clock);
                Map<String,Object> validation=CommandService.validateOne(data,new CommandService.Validation("claim-v1",profiles.get("claim-v1"),
                    "https://rezics.com/definition/claim-v1/"+focus.getKey()+"-shape",List.of(focus.getValue()),List.of(CommandPolicy.CURRENT,CommandPolicy.REVISIONS),Map.of()));
                deadline(deadline,clock); if(validation!=null) return dispositionStatus("unresolved","native retained Claim validation refused");
            }
            String changed=ClaimStatementFoldPolicy.check(data,proof.snapshot()); if(changed!=null) return dispositionStatus("unresolved",changed);
            // Reuse ordinary neutral-commit tracking: a text wrapper can publish
            // a merge even when the only RDF writes are receipts/private state.
            tracksIndex=SearchDeltaJournal.canTrackCommit(logical);
            if(tracksIndex) { publicWriteEpoch.incrementAndGet(); SearchDeltaJournal.fenceBeforeWrite(logical); }
            SearchDeltaJournal.Capture delta=tracksIndex?new SearchDeltaJournal.Capture(logical,false):null;
            JsonObject row=new JsonObject(); row.put("status","retained"); row.put("contract",RETAIN); row.put("sourceCut",state.sourceCut()); row.put("seal",state.hash()); row.put("attempt",state.attempt()); row.put("storage",state.storage());
            row.put("claim",source.claim()); row.put("head",source.head()); row.put("witness",source.witness()); row.put("predicate",proof.predicate().getURI()); row.put("sourceDigest",proof.sourceDigest()); row.put("sourceReceipt",proof.originalReceipt().getURI()); row.put("receipt",RETAIN_PREFIX+digest); row.put("digest",digest);
            for(var field:retentionReceipt(data,request.job(),row).entrySet()) logical.add(RECEIPTS,uri(RETAIN_PREFIX+digest),field.getKey(),field.getValue());
            logical.add(STATE,identity,p("claimFoldRetainedDisposition"),literal(JSON.toStringFlat(row)));
            JsonObject progress=new JsonObject(); progress.put("sourceCut",state.sourceCut()); progress.put("seal",state.hash()); progress.put("attempt",state.attempt()); progress.put("storage",state.storage()); progress.put("version",Math.addExact(version(data),1)); progress.put("claim",source.claim()); progress.put("receipt",RETAIN_PREFIX+digest);
            logical.deleteAny(STATE,progressId(header(request.job())),p("claimFoldConversionCheckpoint"),Node.ANY); logical.add(STATE,progressId(header(request.job())),p("claimFoldConversionCheckpoint"),literal(JSON.toStringFlat(progress)));
            verifyRetentionReceipt(data,request.job(),row); deadline(deadline,clock);
            String post=ClaimStatementFoldPolicy.check(data,proof.snapshot());
            if(post!=null || !state.cut().equals(lineageCut(data,request.job(),deadline,clock))) return dispositionStatus("unresolved","retained original poststate/held cut changed");
            if(delta!=null) SearchDeltaJournal.append(logical,delta,publicWriteEpoch.get()+1);
            deadline(deadline,clock); logical.commit(); committed=true; return row;
        } catch(InventoryDeadline expired) { return dispositionStatus("deadline","retention deadline expired"); }
        catch(IllegalArgumentException invalid) { return dispositionStatus("unresolved",invalid.getMessage()); }
        finally {
            try { if(!committed) logical.abort(); }
            finally {
                try {
                    logical.end();
                    if(committed && tracksIndex) try {
                        if(!Boolean.TRUE.equals(SearchDeltaJournal.qualifiedProof(logical,-1,publicWriteEpoch.get()+1).get("available"))) SearchDeltaJournal.invalidate(logical);
                    } catch(RuntimeException unavailable) { SearchDeltaJournal.invalidate(logical); }
                } finally { if(tracksIndex) publicWriteEpoch.incrementAndGet(); }
            }
        }
        }
    }

    private static Node directory(Job job) { return uri(header(job).getURI()+":members"); }
    private static Node constructionId(Job job) { return uri(directory(job).getURI()+":construction"); }
    private static Node directorySealId(Job job,String attempt) { return uri(directory(job).getURI()+":seal:"+attempt); }
    private static Construction construction(DatasetGraph data,Job job) {
        Set<Quad> fields=record(data,STATE,constructionId(job),1,4096); if(fields.isEmpty()) return null;
        JsonObject row=JSON.parse(text(value(fields,p("claimFoldMemberConstruction"))));
        if(!row.keys().equals(Set.of("count","hash")) || n(row,"count")<0 || !s(row,"hash").matches("[0-9a-f]{64}")) throw new IllegalArgumentException("invalid member directory construction");
        return new Construction(n(row,"count"),s(row,"hash"));
    }
    private static void saveConstruction(DatasetGraph data,Job job,Construction construction) {
        JsonObject row=new JsonObject(); row.put("count",construction.count()); row.put("hash",construction.hash());
        data.deleteAny(STATE,constructionId(job),p("claimFoldMemberConstruction"),Node.ANY);
        data.add(STATE,constructionId(job),p("claimFoldMemberConstruction"),literal(JSON.toStringFlat(row)));
    }
    private static void sealDirectory(DatasetGraph data,Job job,String sourceCut,String seal,String attempt,Construction construction) {
        JsonObject row=new JsonObject(); row.put("contract",MEMBERS); row.put("sourceCut",sourceCut); row.put("seal",seal); row.put("attempt",attempt); row.put("count",construction.count()); row.put("construction",construction.hash());
        Node identity=directorySealId(job,attempt);
        if(!record(data,STATE,identity,1,4096).isEmpty()) throw new IllegalArgumentException("member directory seal is immutable");
        data.add(STATE,identity,p("claimFoldDirectorySeal"),literal(JSON.toStringFlat(row)));
    }
    private static Construction directorySeal(DatasetGraph data,Job job,Checkpoint state) {
        Set<Quad> fields=record(data,STATE,directorySealId(job,state.attempt()),1,4096);
        if(fields.isEmpty()) throw new IllegalArgumentException("original member directory proof unavailable");
        JsonObject row=JSON.parse(text(value(fields,p("claimFoldDirectorySeal"))));
        if(!row.keys().equals(Set.of("contract","sourceCut","seal","attempt","count","construction")) || !s(row,"contract").equals(MEMBERS)
            || !s(row,"sourceCut").equals(state.sourceCut()) || !s(row,"seal").equals(state.hash()) || !s(row,"attempt").equals(state.attempt())
            || n(row,"count")!=state.total() || !s(row,"construction").matches("[0-9a-f]{64}")) throw new IllegalArgumentException("member directory seal differs");
        Construction proof=new Construction(n(row,"count"),s(row,"construction"));
        if(!proof.equals(construction(data,job))) throw new IllegalArgumentException("member directory construction differs"); return proof;
    }
    private static String memberHash(Row row) { return hash(row.claim()+"\n"+row.head()+"\n"+row.witness()); }
    private static String xor(String left,String right) {
        byte[] bytes=HexFormat.of().parseHex(left),other=HexFormat.of().parseHex(right);
        for(int i=0;i<32;i++) bytes[i]^=other[i]; return HexFormat.of().formatHex(bytes);
    }
    static MembersRequest parseMembers(byte[] bytes) {
        JsonObject request=parseEnvelope(bytes,"claimFoldMembers");
        if(!request.keys().equals(Set.of("job","sourceCut","seal","progress","deadline"))) throw new IllegalArgumentException("invalid Claim member fields");
        Job job=parseJob(request.get("job").getAsObject()); long deadline=n(request,"deadline");
        validate(new Request(job,"00000000-0000-0000-0000-000000000000",0,"","00000000-0000-0000-0000-000000000000",deadline));
        String progress=e(request,"progress");
        if(!s(request,"sourceCut").matches("[0-9a-f]{64}") || !s(request,"seal").matches("[0-9a-f]{64}") || progress.length()>4096
            || !progress.isEmpty() && !progress.matches("[A-Za-z0-9_-]+\\.[0-9a-f]{64}")) throw new IllegalArgumentException("invalid Claim member identity/progress");
        return new MembersRequest(job,s(request,"sourceCut"),s(request,"seal"),progress,deadline);
    }
    private static String progressMac(byte[] bytes) {
        try { var mac=javax.crypto.Mac.getInstance("HmacSHA256"); mac.init(new javax.crypto.spec.SecretKeySpec(MEMBER_KEY,"HmacSHA256"));
            mac.update((MEMBERS+"\0").getBytes(StandardCharsets.UTF_8)); return HexFormat.of().formatHex(mac.doFinal(bytes));
        } catch(java.security.GeneralSecurityException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String encodeProgress(JsonObject row) {
        byte[] bytes=JSON.toStringFlat(row).getBytes(StandardCharsets.UTF_8); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)+"."+progressMac(bytes);
    }
    private static JsonObject progress(MembersRequest request,Checkpoint state,Construction proof,long version) {
        if(request.progress().isEmpty()) {
            JsonObject row=new JsonObject(); row.put("job",request.job().marker()); row.put("sourceCut",state.sourceCut()); row.put("seal",state.hash()); row.put("attempt",state.attempt());
            row.put("storage",state.storage()); row.put("version",version); row.put("construction",proof.hash()); row.put("after",""); row.put("count",0); row.put("hash",ZERO); return row;
        }
        String[] parts=request.progress().split("\\."); byte[] bytes=Base64.getUrlDecoder().decode(parts[0]);
        if(bytes.length>2048 || !MessageDigest.isEqual(HexFormat.of().parseHex(parts[1]),HexFormat.of().parseHex(progressMac(bytes)))) throw new IllegalArgumentException("member progress is not native authority");
        JsonObject row=JSON.parse(new String(bytes,StandardCharsets.UTF_8));
        if(!row.keys().equals(Set.of("job","sourceCut","seal","attempt","storage","version","construction","after","count","hash"))
            || !s(row,"job").equals(request.job().marker()) || !s(row,"sourceCut").equals(state.sourceCut()) || !s(row,"seal").equals(state.hash())
            || !s(row,"attempt").equals(state.attempt()) || !s(row,"storage").equals(state.storage()) || n(row,"version")!=version || !s(row,"construction").equals(proof.hash())
            || !s(row,"after").matches("[0-9a-f]{64}") || n(row,"count")<1 || n(row,"count")>proof.count() || !s(row,"hash").matches("[0-9a-f]{64}")) throw new IllegalArgumentException("member progress cut/version differs");
        return row;
    }
    private static Row originalMember(DatasetGraph data,Job job,Node identity) {
        if(!identity.isURI() || identity.getURI().length()>256) throw new IllegalArgumentException("invalid member pointer");
        Set<Quad> fields=record(data,STATE,identity,4,MAX_WITNESS_BYTES);
        if(fields.size()!=4 || !value(fields,p("inventoryJob")).equals(header(job))) throw new IllegalArgumentException("dead or malformed original member row");
        Node claim=value(fields,p("claim")),head=value(fields,p("claimHead")); String witness=text(value(fields,p("witness")));
        if(!nativeId(claim) || !nativeId(head) || !witness.matches("[0-9a-f]{64}") || !identity.equals(uri(header(job).getURI()+":claim:"+hash(claim.getURI())))) throw new IllegalArgumentException("original member identity/witness differs");
        return new Row(claim.getURI(),head.getURI(),witness);
    }
    /** Directory EOF enumerates original members only. It grants no disposition,
     * owner closure, full completion or release authority. */
    static JsonObject readMembers(DatasetGraph logical,MembersRequest request) {
        Clock clock=Clock.systemUTC(); long deadline=Math.min(request.deadline(),clock.millis()+30_000);
        DatasetGraph data=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
        if(data.isInTransaction()) throw new IllegalArgumentException("Claim member reader owns its read transaction");
        try { deadline(deadline,clock); } catch(InventoryDeadline expired) { return dispositionStatus("deadline","Claim member deadline expired"); }
        data.begin(ReadWrite.READ);
        try {
            deadline(deadline,clock); Checkpoint state=checkpoint(data,header(request.job())); deadline(deadline,clock);
            if(!sealed(data,request.job(),state,request.sourceCut(),request.seal(),deadline,clock)) return dispositionStatus("invalid","Claim member source cut/version unavailable");
            Construction proof=directorySeal(data,request.job(),state); deadline(deadline,clock);
            JsonObject cursor=progress(request,state,proof,version(data)); deadline(deadline,clock);
            var storage=TDBInternal.requireStorage(data); var index=(TupleIndexRecord)TDBInternal.findIndex(data,"GSPO").baseTupleIndex();
            var factory=new RecordFactory(32,0); var start=factory.createKeyOnly(); var end=factory.createKeyOnly();
            Node[] prefix={STATE,directory(request.job()),p("claimFoldInventoryMember")}; boolean absent=false;
            for(int i=0;i<3;i++) {
                var id=TDBInternal.getNodeId(storage,prefix[i]);
                if(org.apache.jena.tdb2.store.NodeId.isDoesNotExist(id)) { absent=true; break; }
                NodeIdFactory.set(id,start.getKey(),i*8); NodeIdFactory.set(id,end.getKey(),i*8);
            }
            List<Row> rows=new ArrayList<>(); boolean eof=true; String after=e(cursor,"after"),accumulator=s(cursor,"hash"); long count=n(cursor,"count");
            if(!absent) {
                NodeIdFactory.setNext(TDBInternal.getNodeId(storage,prefix[2]),end.getKey(),16);
                if(!after.isEmpty()) {
                    byte[] key=HexFormat.of().parseHex(after);
                    if(!Arrays.equals(Arrays.copyOf(key,24),Arrays.copyOf(start.getKey(),24))) throw new IllegalArgumentException("member progress prefix differs");
                    System.arraycopy(key,0,start.getKey(),0,32); increment(start.getKey());
                }
                var tuples=index.getRangeIndex().iterator(start,end);
                try {
                    int consumed=0;
                    while(consumed<MAX_TUPLES && tuples.hasNext()) {
                        deadline(deadline,clock); var tuple=tuples.next(); consumed++; deadline(deadline,clock);
                        if(rows.size()==MAX_ROWS) { eof=false; break; }
                        Node identity=storage.getQuadTable().getNodeTupleTable().getNodeTable().getNodeForNodeId(NodeIdFactory.get(tuple.getKey(),24));
                        Row row=originalMember(data,request.job(),identity); deadline(deadline,clock);
                        rows.add(row); count=Math.addExact(count,1); accumulator=xor(accumulator,memberHash(row)); after=HexFormat.of().formatHex(tuple.getKey());
                        if(count>proof.count()) throw new IllegalArgumentException("duplicate/extra member directory tuple");
                    }
                } finally { Iter.close(tuples); }
            }
            if(eof && (count!=proof.count() || !accumulator.equals(proof.hash()))) throw new IllegalArgumentException("member EOF construction proof differs");
            cursor.put("after",after); cursor.put("count",count); cursor.put("hash",accumulator);
            JsonObject result=new JsonObject(); result.put("status","read"); result.put("directoryEOF",eof); result.put("sourceCut",state.sourceCut()); result.put("seal",state.hash());
            result.put("count",count); result.put("rows",rowsJson(rows)); result.put("progress",eof?"":encodeProgress(cursor));
            if(JSON.toStringFlat(result).getBytes(StandardCharsets.UTF_8).length>MAX_PAGE_BYTES) throw new IllegalArgumentException("member response exceeds byte bound");
            deadline(deadline,clock); return result;
        } catch(InventoryDeadline expired) { return dispositionStatus("deadline","Claim member deadline expired"); }
        catch(IllegalArgumentException invalid) { return dispositionStatus("invalid",invalid.getMessage()); }
        finally { data.end(); }
    }

    private static final String CLASSIFY="claim-fold-classify-v1";
    /** Only this fixed reader uses the facade; no writer or general projection
     * observes it. Every returned tuple and empty probe shares one turn budget. */
    private static final class ClassificationWork extends DatasetGraphWrapper {
        int tuples,probes,bytes; final int maxTuples,maxProbes,maxBytes;
        ClassificationWork(DatasetGraph data) { this(data,512,128,256*1024); }
        ClassificationWork(DatasetGraph data,int maxTuples,int maxProbes,int maxBytes) { super(data); this.maxTuples=maxTuples; this.maxProbes=maxProbes; this.maxBytes=maxBytes; }
        void probe() { if(probes==maxProbes) throw new ClassificationBudget(); probes++; }
        void tupleRoom() { if(tuples==maxTuples) throw new ClassificationBudget(); }
        void charge(Node... nodes) {
            tupleRoom(); tuples++;
            for(Node node:nodes) try { bytes=Math.addExact(bytes,scalarBytes(node,maxBytes-bytes)); }
            catch(IllegalArgumentException invalid) { throw new ClassificationBudget(); }
        }
        boolean reserve() { return tuples+128+96<=512 && probes+40+28<=128 && bytes+160*1024<=256*1024; }
        @Override public Iterator<Quad> find(Node graph,Node subject,Node predicate,Node object) {
            probe(); Iterator<Quad> source=super.find(graph,subject,predicate,object);
            class Lookahead implements Iterator<Quad>,org.apache.jena.atlas.lib.Closeable {
                Quad next;boolean ready;
                @Override public boolean hasNext(){if(ready)return true;tupleRoom();if(!source.hasNext())return false;next=source.next();charge(next.getGraph(),next.getSubject(),next.getPredicate(),next.getObject());ready=true;return true;}
                @Override public Quad next(){if(!hasNext())throw new NoSuchElementException();ready=false;return next;}
                @Override public void close(){Iter.close(source);}
            }
            return new Lookahead();
        }
        @Override public boolean contains(Node graph,Node subject,Node predicate,Node object) {
            var found=find(graph,subject,predicate,object);
            try { if(!found.hasNext()) return false; found.next(); return true; } finally { Iter.close(found); }
        }
        JsonObject json() { JsonObject row=new JsonObject();row.put("tuples",tuples);row.put("probes",probes);row.put("bytes",bytes);return row; }
    }
    private static final class ClassificationBudget extends RuntimeException { private static final long serialVersionUID=1L; }
    static MembersRequest parseClassify(byte[] bytes) {
        JsonObject row=parseEnvelope(bytes,"claimFoldClassify");
        if(!row.keys().equals(Set.of("job","sourceCut","seal","progress","deadline"))) throw new IllegalArgumentException("invalid fixed classification fields");
        Job job=parseJob(row.get("job").getAsObject()); String cursor=e(row,"progress"); long deadline=n(row,"deadline");
        validate(new Request(job,"00000000-0000-0000-0000-000000000000",0,"","00000000-0000-0000-0000-000000000000",deadline));
        if(!s(row,"sourceCut").matches("[0-9a-f]{64}") || !s(row,"seal").matches("[0-9a-f]{64}") || cursor.length()>4096
            || !cursor.isEmpty() && !cursor.matches("[A-Za-z0-9_-]+\\.[0-9a-f]{64}")) throw new IllegalArgumentException("invalid classification source/progress");
        return new MembersRequest(job,s(row,"sourceCut"),s(row,"seal"),cursor,deadline);
    }
    private static String classificationMac(byte[] bytes) { return purposeMac(CLASSIFY,bytes); }
    private static String purposeMac(String purpose,byte[] bytes) {
        try { var mac=javax.crypto.Mac.getInstance("HmacSHA256");mac.init(new javax.crypto.spec.SecretKeySpec(MEMBER_KEY,"HmacSHA256"));mac.update((purpose+"\0").getBytes(StandardCharsets.UTF_8));return HexFormat.of().formatHex(mac.doFinal(bytes)); }
        catch(java.security.GeneralSecurityException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String classificationToken(JsonObject cursor) {
        byte[] bytes=JSON.toStringFlat(cursor).getBytes(StandardCharsets.UTF_8);return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)+"."+classificationMac(bytes);
    }
    private static JsonObject classificationCursor(MembersRequest request,Checkpoint state,Construction proof,long snapshot) {
        JsonObject cursor;
        if(request.progress().isEmpty()) {
            cursor=progress(new MembersRequest(request.job(),request.sourceCut(),request.seal(),"",request.deadline()),state,proof,snapshot);
            cursor.put("purpose",CLASSIFY);cursor.put("converted",0);cursor.put("retained",0);cursor.put("transcript",ZERO);return cursor;
        }
        String[] parts=request.progress().split("\\.");byte[] bytes=Base64.getUrlDecoder().decode(parts[0]);
        if(bytes.length>2048 || !MessageDigest.isEqual(HexFormat.of().parseHex(parts[1]),HexFormat.of().parseHex(classificationMac(bytes)))) throw new IllegalArgumentException("classification cursor purpose/authentication differs");
        cursor=JSON.parse(new String(bytes,StandardCharsets.UTF_8));
        if(!cursor.keys().equals(Set.of("job","sourceCut","seal","attempt","storage","version","construction","after","count","hash","purpose","converted","retained","transcript"))
            || !s(cursor,"purpose").equals(CLASSIFY) || !s(cursor,"job").equals(request.job().marker()) || !s(cursor,"sourceCut").equals(state.sourceCut()) || !s(cursor,"seal").equals(state.hash())
            || !s(cursor,"attempt").equals(state.attempt()) || !s(cursor,"storage").equals(state.storage()) || n(cursor,"version")!=snapshot || !s(cursor,"construction").equals(proof.hash())
            || !s(cursor,"after").matches("[0-9a-f]{64}") || n(cursor,"count")<1 || n(cursor,"count")>proof.count() || !s(cursor,"hash").matches("[0-9a-f]{64}") || !s(cursor,"transcript").matches("[0-9a-f]{64}")
            || n(cursor,"converted")<0 || n(cursor,"retained")<0 || n(cursor,"converted")+n(cursor,"retained")!=n(cursor,"count")) throw new IllegalArgumentException("classification cursor cut/partition differs");return cursor;
    }
    private static JsonObject classifyMember(DatasetGraph data,Job job,Checkpoint state,Row member) {
        Node claim=uri(member.claim()),root=uri(member.head());
        JsonObject converted=disposition(data,dispositionId(job,claim),state),retained=retainedDisposition(data,retainedId(job,claim),state);
        if((converted==null)==(retained==null)) throw new IllegalArgumentException("original member lacks one exclusive native disposition");
        JsonObject selected=converted==null?retained:converted;
        if(!s(selected,"claim").equals(member.claim()) || !s(selected,"head").equals(member.head()) || !s(selected,"witness").equals(member.witness())) throw new IllegalArgumentException("classified disposition original witness differs");
        Row actual=witness(data,claim,converted==null?CURRENT:uri(CommandPolicy.REVISIONS));
        if(!actual.equals(member)) throw new IllegalArgumentException("classified original C/R witness changed");
        Node original;String sourceDigest;
        if(converted!=null) {
            Node own=uri(s(converted,"receipt")),revision=uri(s(converted,"statementRevision"));
            Map<Node,Node> required=Map.ofEntries(Map.entry(RDF.type.asNode(),p("OperationReceipt")),Map.entry(p("commandFamily"),literal("claim-statement-fold-convert-v1")),Map.entry(p("outcome"),p("Succeeded")),
                Map.entry(p("datasetId"),PRODUCT),Map.entry(p("dataEpoch"),literal(job.dataEpoch())),Map.entry(p("sequence"),one(data,RECEIPTS,uri(job.acquireReceipt()),p("sequence"),true)),Map.entry(p("claimStatementFold"),uri(job.marker())),Map.entry(p("foldMapDigest"),literal(job.mapDigest())),Map.entry(p("claimFoldJob"),literal(job.job())),
                Map.entry(p("convertedClaim"),claim),Map.entry(p("sourceClaimRevision"),root),Map.entry(p("statementRevision"),revision),Map.entry(p("requestDigest"),literal(s(converted,"digest"))),Map.entry(p("claimFoldTemplateDigest"),literal(s(converted,"templateDigest"))));
            for(var field:required.entrySet()) {Node value=one(data,RECEIPTS,own,field.getKey(),true);scalarBytes(value,MAX_WITNESS_BYTES);if(!value.equals(field.getValue())) throw new IllegalArgumentException("classified native conversion receipt differs");}
            Node revisions=uri(CommandPolicy.REVISIONS);
            if(!one(data,revisions,revision,p("component"),true).equals(claim) || !one(data,revisions,revision,p("retainedSourceRevision"),true).equals(root)) throw new IllegalArgumentException("classified B original provenance differs");
            original=one(data,revisions,revision,p("retainedSourceReceipt"),true);scalarBytes(original,MAX_WITNESS_BYTES);
            Node digest=one(data,RECEIPTS,own,p("sourceDigest"),true);scalarBytes(digest,MAX_WITNESS_BYTES);sourceDigest=text(digest);
        } else {
            verifyRetentionReceipt(data,job,retained);original=uri(s(retained,"sourceReceipt"));sourceDigest=s(retained,"sourceDigest");
            if(!one(data,CURRENT,claim,p("propositionPredicate"),true).equals(uri(s(retained,"predicate"))) || !one(data,uri(CommandPolicy.REVISIONS),root,p("propositionPredicate"),true).equals(uri(s(retained,"predicate")))) throw new IllegalArgumentException("classified retained predicate differs");
        }
        if(!sourceDigest.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("classified source digest differs");
        Set<Quad> receipt=record(data,RECEIPTS,original,32,16*1024);
        Node epoch=one(data,uri(CommandPolicy.REVISIONS),root,p("dataEpoch"),true),sequence=one(data,uri(CommandPolicy.REVISIONS),root,p("sequence"),true);
        ClaimStatementFoldPolicy.verifyOriginalReceipt(original,receipt,claim,root,epoch,sequence);
        if(converted!=null) {
            Node revision=uri(s(converted,"statementRevision")),revisions=uri(CommandPolicy.REVISIONS);
            if(!data.contains(revisions,revision,RDF.type.asNode(),p("StatementRevision")) || !data.contains(revisions,revision,RDF.type.asNode(),p("RevisionAnchor"))
                || !one(data,revisions,revision,p("dataEpoch"),true).equals(epoch) || !one(data,revisions,revision,p("sequence"),true).equals(sequence)
                || !one(data,revisions,revision,p("operation"),true).equals(value(receipt,p("operation")))) throw new IllegalArgumentException("classified B original create provenance differs");
        }
        JsonObject result=new JsonObject();result.put("claim",member.claim());result.put("head",member.head());result.put("witness",member.witness());result.put("status",s(selected,"status"));
        result.put("receipt",s(selected,"receipt"));result.put("digest",s(selected,"digest"));result.put("sourceDigest",sourceDigest);result.put("sourceReceipt",original.getURI());
        if(converted!=null) result.put("statementRevision",s(converted,"statementRevision"));return result;
    }
    /** Snapshot-only native classification. No marker, mutation, owner coverage,
     * complete/release or latest-commit assertion is emitted. */
    static JsonObject classify(DatasetGraph logical,MembersRequest request) {
        Clock clock=Clock.systemUTC();long deadline=Math.min(request.deadline(),clock.millis()+30_000);
        DatasetGraph raw=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
        if(raw.isInTransaction()) throw new IllegalArgumentException("classification owns its read transaction");
        ClassificationWork data=new ClassificationWork(raw);
        try {deadline(deadline,clock);} catch(InventoryDeadline expired){return dispositionStatus("deadline","classification deadline expired");}
        raw.begin(ReadWrite.READ);
        try {
            deadline(deadline,clock);Checkpoint state=checkpoint(data,header(request.job()));
            if(!sealed(data,request.job(),state,request.sourceCut(),request.seal(),deadline,clock)) throw new IllegalArgumentException("classification source cut/version unavailable");
            Construction proof=directorySeal(data,request.job(),state);long snapshot=version(raw);JsonObject cursor=classificationCursor(request,state,proof,snapshot);deadline(deadline,clock);
            var index=(TupleIndexRecord)TDBInternal.findIndex(raw,"GSPO").baseTupleIndex();var factory=new RecordFactory(32,0);var start=factory.createKeyOnly();var end=factory.createKeyOnly();
            Node[] prefix={STATE,directory(request.job()),p("claimFoldInventoryMember")};boolean absent=false;
            for(int i=0;i<3;i++){var id=TDBInternal.getNodeId(TDBInternal.requireStorage(raw),prefix[i]);if(org.apache.jena.tdb2.store.NodeId.isDoesNotExist(id)){absent=true;break;}NodeIdFactory.set(id,start.getKey(),i*8);NodeIdFactory.set(id,end.getKey(),i*8);}
            String after=e(cursor,"after"),accumulator=s(cursor,"hash"),transcript=s(cursor,"transcript");long count=n(cursor,"count"),converted=n(cursor,"converted"),retained=n(cursor,"retained");
            JsonArray rows=new JsonArray();boolean eof=true;
            if(!absent){
                NodeIdFactory.setNext(TDBInternal.getNodeId(TDBInternal.requireStorage(raw),prefix[2]),end.getKey(),16);
                if(!after.isEmpty()){byte[] key=HexFormat.of().parseHex(after);if(!Arrays.equals(Arrays.copyOf(key,24),Arrays.copyOf(start.getKey(),24))) throw new IllegalArgumentException("classification cursor prefix differs");System.arraycopy(key,0,start.getKey(),0,32);increment(start.getKey());}
                data.probe();var tuples=index.getRangeIndex().iterator(start,end);
                try {while(true){
                    data.tupleRoom();if(!tuples.hasNext())break;deadline(deadline,clock);var tuple=tuples.next();Node identity=TDBInternal.requireStorage(raw).getQuadTable().getNodeTupleTable().getNodeTable().getNodeForNodeId(NodeIdFactory.get(tuple.getKey(),24));data.charge(prefix[0],prefix[1],prefix[2],identity);deadline(deadline,clock);
                    if(rows.size()==2 || !data.reserve()){eof=false;break;}
                    Row member=originalMember(data,request.job(),identity);JsonObject result=classifyMember(data,request.job(),state,member);deadline(deadline,clock);
                    rows.add(result);count=Math.addExact(count,1);if(s(result,"status").equals("converted"))converted++;else retained++;
                    if(count>proof.count()) throw new IllegalArgumentException("classification directory duplicates/extra members");
                    accumulator=xor(accumulator,memberHash(member));transcript=hash(transcript+"\n"+JSON.toStringFlat(result));after=HexFormat.of().formatHex(tuple.getKey());
                }}finally{Iter.close(tuples);}
            }
            if(rows.isEmpty()&&!eof)throw new ClassificationBudget();
            if(eof && (count!=proof.count() || !accumulator.equals(proof.hash()) || converted+retained!=count)) throw new IllegalArgumentException("classification EOF original partition differs");
            if(eof) {
                JsonObject stored=classification(data,header(request.job()),state,true);
                if(stored!=null && (!s(stored,"construction").equals(proof.hash()) || number(stored,"count")!=count || number(stored,"converted")!=converted || number(stored,"retained")!=retained || !s(stored,"transcript").equals(transcript))) throw new IllegalArgumentException("classification EOF differs from the stored marker");
            }
            Checkpoint finalState=checkpoint(data,header(request.job()));
            if(!state.equals(finalState)||version(raw)!=snapshot||!sealed(data,request.job(),finalState,request.sourceCut(),request.seal(),deadline,clock)||!proof.equals(directorySeal(data,request.job(),finalState)))throw new IllegalArgumentException("classification final snapshot cut differs");
            cursor.put("after",after);cursor.put("count",count);cursor.put("hash",accumulator);cursor.put("transcript",transcript);cursor.put("converted",converted);cursor.put("retained",retained);
            JsonObject result=new JsonObject();result.put("status","classified");result.put("classificationEOF",eof);result.put("sourceCut",state.sourceCut());result.put("seal",state.hash());result.put("storage",state.storage());result.put("snapshotVersion",snapshot);
            result.put("count",count);result.put("converted",converted);result.put("retained",retained);result.put("transcript",transcript);result.put("rows",rows);result.put("progress",eof?"":classificationToken(cursor));
            if(eof && count>0) {
                JsonObject proofPayload=new JsonObject();proofPayload.put("purpose",SEALED);proofPayload.put("job",request.job().marker());proofPayload.put("sourceCut",state.sourceCut());proofPayload.put("seal",state.hash());proofPayload.put("attempt",state.attempt());proofPayload.put("storage",state.storage());
                proofPayload.put("snapshotVersion",snapshot);proofPayload.put("construction",proof.hash());proofPayload.put("count",count);proofPayload.put("converted",converted);proofPayload.put("retained",retained);proofPayload.put("transcript",transcript);
                result.put("classifiedProof",classifiedToken(proofPayload));
            }
            result.put("work",data.json());
            if(JSON.toStringFlat(result).getBytes(StandardCharsets.UTF_8).length>16*1024)throw new ClassificationBudget();deadline(deadline,clock);return result;
        }catch(InventoryDeadline expired){return dispositionStatus("deadline","classification deadline expired");}
        catch(ClassificationBudget exhausted){return dispositionStatus("budget","classification total work budget exhausted");}
        catch(IllegalArgumentException invalid){return dispositionStatus("unresolved",invalid.getMessage());}
        finally{raw.end();}
    }

    private static final String SEALED="claim-fold-classified-v1", SEALED_PREFIX="urn:rezics:claim-fold-classified:";
    /** Hard caps for the whole seal request: replay read, cold cut checks, proof
     * comparison and the post-staging link check, including lookahead and empty probes.
     * Measured on the 129-member corpus: 57 tuples/31 probes/17023 bytes, unchanged by 5000 unrelated acks. */
    static final int SEAL_TUPLES=128, SEAL_PROBES=64, SEAL_BYTES=64*1024;
    private static final Set<String> MARKER_KEYS=Set.of("contract","status","sourceCut","seal","attempt","storage","construction","count","converted","retained","transcript","snapshotVersion","version","requestDigest","receipt","proof");
    private static final Set<String> EOF_KEYS=Set.of("purpose","job","sourceCut","seal","attempt","storage","snapshotVersion","construction","count","converted","retained","transcript");
    private static final int MAX_PROOF=2048;
    record SealRequest(Job job,String sourceCut,String seal,String proof,long deadline) {}
    private static Node classifiedId(Node header) { return uri(header.getURI()+":classified"); }
    private static String classifiedToken(JsonObject payload) {
        byte[] bytes=JSON.toStringFlat(payload).getBytes(StandardCharsets.UTF_8);return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)+"."+purposeMac(SEALED,bytes);
    }
    static SealRequest parseClassifySeal(byte[] bytes) {
        JsonObject row=parseEnvelope(bytes,"claimFoldClassifySeal");
        if(!row.keys().equals(Set.of("job","sourceCut","seal","proof","deadline"))) throw new IllegalArgumentException("invalid fixed classification seal fields");
        Job job=parseJob(row.get("job").getAsObject()); long deadline=n(row,"deadline");
        validate(new Request(job,"00000000-0000-0000-0000-000000000000",0,"","00000000-0000-0000-0000-000000000000",deadline));
        String proof=s(row,"proof");
        if(!s(row,"sourceCut").matches("[0-9a-f]{64}") || !s(row,"seal").matches("[0-9a-f]{64}") || proof.length()>MAX_PROOF || !proof.matches("[A-Za-z0-9_-]+\\.[0-9a-f]{64}")) throw new IllegalArgumentException("invalid classification seal source/proof");
        return new SealRequest(job,s(row,"sourceCut"),s(row,"seal"),proof,deadline);
    }
    private static long number(JsonObject row,String key) {
        JsonValue value=row.get(key);
        if(value==null || !value.isNumber()) throw new IllegalArgumentException("classification number field differs");
        try { return new java.math.BigDecimal(value.getAsNumber().value().toString()).longValueExact(); } catch(ArithmeticException invalid) { throw new IllegalArgumentException("classification number field differs",invalid); }
    }
    /** The original EOF token carries the exact snapshot facts. `authenticate` is false only for a historical ack whose process MAC has expired. */
    private static JsonObject eofPayload(String proof,boolean authenticate) {
        String[] parts=proof.split("\\.");
        if(parts.length!=2 || proof.length()>MAX_PROOF) throw new IllegalArgumentException("classification proof shape differs");
        byte[] bytes=Base64.getUrlDecoder().decode(parts[0]);
        if(bytes.length>2048 || authenticate && !MessageDigest.isEqual(HexFormat.of().parseHex(parts[1]),HexFormat.of().parseHex(purposeMac(SEALED,bytes)))) throw new IllegalArgumentException("classification proof purpose/authentication differs");
        JsonObject payload;
        try { payload=JSON.parse(new String(bytes,StandardCharsets.UTF_8)); } catch(JsonParseException invalid) { throw new IllegalArgumentException("classification proof fields differ",invalid); }
        if(!payload.keys().equals(EOF_KEYS) || !s(payload,"purpose").equals(SEALED)) throw new IllegalArgumentException("classification proof fields differ");
        for(String key:List.of("snapshotVersion","count","converted","retained")) number(payload,key);
        return payload;
    }
    /** Every original EOF fact must equal the stored record; a restamped field cannot hide behind a matching digest. */
    private static void sameEof(JsonObject eof,JsonObject row) {
        for(String key:List.of("sourceCut","seal","attempt","storage","construction","transcript")) if(!s(eof,key).equals(s(row,key))) throw new IllegalArgumentException("classification record differs from its original EOF: "+key);
        for(String key:List.of("snapshotVersion","count","converted","retained")) if(number(eof,key)!=number(row,key)) throw new IllegalArgumentException("classification record differs from its original EOF: "+key);
    }
    /** Closed marker validation against the persisted checkpoint and its retained original EOF token. Fresh authority also requires this process's MAC; no current incarnation is consulted. */
    private static JsonObject classification(DatasetGraph data,Node header,Checkpoint state,boolean fresh) {
        Set<Quad> fields=record(data,STATE,classifiedId(header),1,8192); if(fields.isEmpty()) return null;
        JsonObject row;
        try { row=JSON.parse(text(value(fields,p("claimFoldClassification")))); } catch(JsonParseException invalid) { throw new IllegalArgumentException("invalid native classification marker",invalid); }
        if(state==null || !row.keys().equals(MARKER_KEYS)) throw new IllegalArgumentException("invalid native classification marker");
        long count=number(row,"count"),converted=number(row,"converted"),retained=number(row,"retained"),snapshot=number(row,"snapshotVersion"),version=number(row,"version");
        if(!s(row,"contract").equals(SEALED) || !s(row,"status").equals("classified") || !s(row,"sourceCut").equals(state.sourceCut()) || !s(row,"seal").equals(state.hash())
            || !s(row,"attempt").equals(state.attempt()) || !s(row,"storage").equals(state.storage()) || !s(row,"construction").matches("[0-9a-f]{64}") || !s(row,"transcript").matches("[0-9a-f]{64}")
            || count<1 || count!=state.total() || converted<0 || retained<0 || Math.addExact(converted,retained)!=count || snapshot<state.version() || version!=Math.addExact(snapshot,1)
            || !s(row,"requestDigest").matches("[0-9a-f]{64}") || !s(row,"receipt").equals(SEALED_PREFIX+s(row,"requestDigest"))
            || !s(row,"proof").matches("[A-Za-z0-9_-]+\\.[0-9a-f]{64}") || !s(row,"requestDigest").equals(hash(s(row,"proof")))) throw new IllegalArgumentException("invalid native classification marker");
        JsonObject eof=eofPayload(s(row,"proof"),fresh); sameEof(eof,row);
        String marker=header.getURI().substring(0,header.getURI().length()-":inventory".length());
        if(!s(eof,"job").equals(marker)) throw new IllegalArgumentException("classification record differs from its original EOF: job");
        return row;
    }
    /** Exact persisted lost-ACK replay: the original token is decoded and every field compared to the stored marker. Only the expired process MAC is skipped; it never asserts currentness. */
    private static JsonObject sealReplay(DatasetGraph data,SealRequest request,Checkpoint state) {
        Node header=header(request.job()); JsonObject marker=classification(data,header,state,false); if(marker==null) return null;
        JsonObject eof=eofPayload(request.proof(),false);
        if(!s(marker,"proof").equals(request.proof()) || !s(marker,"requestDigest").equals(hash(request.proof())) || !s(marker,"sourceCut").equals(request.sourceCut()) || !s(marker,"seal").equals(request.seal()) || !s(eof,"job").equals(request.job().marker())) throw new IllegalArgumentException("classification marker is immutable and differs from this proof");
        sameEof(eof,marker);
        if(expectedVersion(data,header,state,false)!=number(marker,"version")) throw new IllegalArgumentException("classification terminal link differs");
        return marker;
    }
    /** The MAC proves this process produced an actual EOF at the bound snapshot; equal data version under the writer then proves no commit intervened. */
    private static JsonObject sealProof(SealRequest request,Checkpoint state,Construction directory,long snapshot) {
        JsonObject proof=eofPayload(request.proof(),true);
        long count=number(proof,"count"),converted=number(proof,"converted"),retained=number(proof,"retained");
        if(!s(proof,"job").equals(request.job().marker()) || !s(proof,"sourceCut").equals(state.sourceCut()) || !s(proof,"sourceCut").equals(request.sourceCut())
            || !s(proof,"seal").equals(state.hash()) || !s(proof,"seal").equals(request.seal()) || !s(proof,"attempt").equals(state.attempt()) || !s(proof,"storage").equals(state.storage())
            || number(proof,"snapshotVersion")!=snapshot || !s(proof,"construction").equals(directory.hash()) || count!=directory.count() || count!=state.total() || count<1
            || converted<0 || retained<0 || Math.addExact(converted,retained)!=count || !s(proof,"transcript").matches("[0-9a-f]{64}")) throw new IllegalArgumentException("classification proof differs from the current original partition");
        return proof;
    }
    private static JsonObject sealResult(JsonObject marker,boolean replay,ClassificationWork data) {
        JsonObject result=new JsonObject(); result.put("status","sealed"); result.put("replay",replay); result.put("marker",marker); result.put("work",data.json()); return result;
    }
    static JsonObject sealClassification(DatasetGraph logical,SealRequest request,java.util.concurrent.atomic.AtomicLong publicWriteEpoch) { return sealClassification(logical,request,publicWriteEpoch,Clock.systemUTC()); }
    /** Records classified EOF once. Fresh sealing is current-only; an exact stored request replays as history. No owner, Content, Access, seek, complete or release authority. */
    static JsonObject sealClassification(DatasetGraph logical,SealRequest request,java.util.concurrent.atomic.AtomicLong publicWriteEpoch,Clock clock) {
        long deadline=Math.min(request.deadline(),clock.millis()+30_000);
        DatasetGraph raw=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
        if(raw.isInTransaction()) throw new IllegalArgumentException("classification seal owns its transactions");
        ClassificationWork data=new ClassificationWork(raw,SEAL_TUPLES,SEAL_PROBES,SEAL_BYTES); Node header=header(request.job());
        try { deadline(deadline,clock); } catch(InventoryDeadline expired) { return dispositionStatus("deadline","classification seal deadline expired"); }
        logical.begin(ReadWrite.READ);
        try {
            deadline(deadline,clock); Checkpoint state=checkpoint(data,header); if(state==null || !state.sealed()) return dispositionStatus("unresolved","classification seal requires a registered sealed inventory");
            JsonObject old=sealReplay(data,request,state); deadline(deadline,clock); if(old!=null) return sealResult(old,true,data);
        } catch(InventoryDeadline expired) { return dispositionStatus("deadline","classification seal deadline expired"); }
        catch(ClassificationBudget exhausted) { return dispositionStatus("budget","classification seal work budget exhausted"); }
        catch(IllegalArgumentException invalid) { return dispositionStatus("unresolved",invalid.getMessage()); }
        finally { logical.end(); }
        synchronized(logical) {
        try { deadline(deadline,clock); } catch(InventoryDeadline expired) { return dispositionStatus("deadline","classification seal deadline expired"); }
        logical.begin(ReadWrite.WRITE); boolean committed=false, tracksIndex=false;
        try {
            deadline(deadline,clock); Checkpoint state=checkpoint(data,header); if(state==null || !state.sealed()) return dispositionStatus("unresolved","classification seal requires a registered sealed inventory");
            JsonObject old=sealReplay(data,request,state); deadline(deadline,clock); if(old!=null) return sealResult(old,true,data);
            if(!sealed(data,request.job(),state,request.sourceCut(),request.seal(),deadline,clock)) return dispositionStatus("unresolved","classification seal source cut/version unavailable");
            Construction directory=directorySeal(data,request.job(),state); long snapshot=version(raw); deadline(deadline,clock);
            sealProof(request,state,directory,snapshot); deadline(deadline,clock);
            JsonObject proof=eofPayload(request.proof(),true); String digest=hash(request.proof());
            tracksIndex=SearchDeltaJournal.canTrackCommit(logical);
            if(tracksIndex) { publicWriteEpoch.incrementAndGet(); SearchDeltaJournal.fenceBeforeWrite(logical); }
            SearchDeltaJournal.Capture delta=tracksIndex?new SearchDeltaJournal.Capture(logical,false):null;
            JsonObject marker=new JsonObject(); marker.put("contract",SEALED); marker.put("status","classified"); marker.put("sourceCut",state.sourceCut()); marker.put("seal",state.hash()); marker.put("attempt",state.attempt()); marker.put("storage",state.storage());
            marker.put("construction",directory.hash()); marker.put("count",directory.count()); marker.put("converted",number(proof,"converted")); marker.put("retained",number(proof,"retained")); marker.put("transcript",s(proof,"transcript"));
            marker.put("snapshotVersion",snapshot); marker.put("version",Math.addExact(snapshot,1)); marker.put("requestDigest",digest); marker.put("receipt",SEALED_PREFIX+digest); marker.put("proof",request.proof());
            JsonObject link=new JsonObject(); link.put("sourceCut",state.sourceCut()); link.put("seal",state.hash()); link.put("attempt",state.attempt()); link.put("storage",state.storage()); link.put("version",Math.addExact(snapshot,1)); link.put("claim",""); link.put("receipt",SEALED_PREFIX+digest);
            if(JSON.toStringFlat(marker).getBytes(StandardCharsets.UTF_8).length>4096) return dispositionStatus("unresolved","classification marker exceeds its fixed footprint");
            logical.add(STATE,classifiedId(header),p("claimFoldClassification"),literal(JSON.toStringFlat(marker)));
            logical.deleteAny(STATE,progressId(header),p("claimFoldConversionCheckpoint"),Node.ANY); logical.add(STATE,progressId(header),p("claimFoldConversionCheckpoint"),literal(JSON.toStringFlat(link)));
            deadline(deadline,clock);
            if(!JSON.toStringFlat(classification(data,header,state,true)).equals(JSON.toStringFlat(marker)) || expectedVersion(data,header,state)!=Math.addExact(snapshot,1) || !state.cut().equals(lineageCut(data,request.job(),deadline,clock))) return dispositionStatus("unresolved","classification marker/link/held cut changed");
            if(delta!=null) SearchDeltaJournal.append(logical,delta,publicWriteEpoch.get()+1);
            deadline(deadline,clock); logical.commit(); committed=true; return sealResult(marker,false,data);
        } catch(InventoryDeadline expired) { return dispositionStatus("deadline","classification seal deadline expired"); }
        catch(ClassificationBudget exhausted) { return dispositionStatus("budget","classification seal work budget exhausted"); }
        catch(IllegalArgumentException invalid) { return dispositionStatus("unresolved",invalid.getMessage()); }
        finally {
            try { if(!committed) logical.abort(); }
            finally {
                try {
                    logical.end();
                    if(committed && tracksIndex) try {
                        if(!Boolean.TRUE.equals(SearchDeltaJournal.qualifiedProof(logical,-1,publicWriteEpoch.get()+1).get("available"))) SearchDeltaJournal.invalidate(logical);
                    } catch(RuntimeException unavailable) { SearchDeltaJournal.invalidate(logical); }
                } finally { if(tracksIndex) publicWriteEpoch.incrementAndGet(); }
            }
        }
        }
    }

    static Result turn(DatasetGraph logical,Request request) { return turn(logical,request,Clock.systemUTC()); }
    /** The controlled clock qualifies admission waits without changing the production budget. */
    static Result turn(DatasetGraph logical,Request request,Clock clock) {
        long entryDeadline=Math.addExact(clock.millis(),30_000), workDeadline=Math.min(request.deadline(),entryDeadline);
        validate(request);
        DatasetGraph data=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
        if(data.isInTransaction()) throw new IllegalArgumentException("Claim inventory owns its maintenance transaction");
        Node header=header(request.job()), receipt=uri("urn:rezics:claim-inventory-turn:"+request.requestId());
        String input=hash(JSON.toStringFlat(requestJson(request)));
        // Expired requests may recover an immutable historical result, but never
        // enter WRITE admission on that exception or renew source authority.
        try { deadline(entryDeadline,clock); }
        catch(InventoryDeadline expired) { return refused(request,"deadline","inventory deadline expired"); }
        data.begin(ReadWrite.READ);
        try {
            deadline(entryDeadline,clock);
            Result replay=retained(data,request,receipt,input,entryDeadline,clock);
            if(replay!=null) { lineageCut(data,request.job(),entryDeadline,clock); deadline(entryDeadline,clock); return replay; }
        } catch(InventoryDeadline expired) { return refused(request,"deadline","inventory deadline expired"); }
        catch(IllegalArgumentException invalid) { return refused(request,"invalid",invalid.getMessage()); }
        finally { data.end(); }
        try { deadline(workDeadline,clock); }
        catch(InventoryDeadline expired) { return refused(request,"deadline","inventory deadline expired"); }
        data.begin(ReadWrite.WRITE); boolean committed=false;
        try {
            deadline(workDeadline,clock); // includes all time spent waiting for the writer
            String cut=heldCut(data,request.job(),workDeadline,clock);
            Result replay=retained(data,request,receipt,input,workDeadline,clock);
            if(replay!=null) return replay; // another writer may have acknowledged this request
            deadline(workDeadline,clock);
            Checkpoint old=checkpoint(data,header); deadline(workDeadline,clock); String storage=incarnation(data); long version=version(data); deadline(workDeadline,clock);
            if(old!=null && !old.cut().equals(cut)) return refused(request,"invalid","owned held cut changed");
            Construction construction=construction(data,request.job()); deadline(workDeadline,clock);
            if(old!=null && construction==null) return refused(request,"invalid","old inventory lacks member directory construction; cannot retrofit");
            if(old==null && (construction!=null || data.contains(STATE,directory(request.job()),p("claimFoldInventoryMember"),Node.ANY))) return refused(request,"invalid","orphan member directory");
            if(construction==null) construction=new Construction(0,ZERO);
            if(old!=null && construction.count()!=old.count()) return refused(request,"invalid","member directory construction count differs");
            if(old!=null && old.sealed()) directorySeal(data,request.job(),old);
            boolean fresh=request.page()==0 && request.previous().isEmpty() && (old==null || !old.attempt().equals(request.attempt()));
            if(!fresh && (old==null || !old.attempt().equals(request.attempt()) || request.page()!=old.page() || !request.previous().equals(old.hash()))) return refused(request,"conflict","inventory checkpoint CAS differs");
            if(!fresh && (!old.storage().equals(storage) || old.version()!=version)) return refused(request,"restart-required","physical cursor invalid; begin a new attempt");
            Node attempt=uri(header.getURI()+":attempt:"+request.attempt()); deadline(workDeadline,clock);
            if(fresh && one(data,STATE,attempt,p("sourceCut"),false)!=null) return refused(request,"conflict","inventory attempt cannot be reused");
            deadline(workDeadline,clock);
            if(!fresh && old.sealed()) return refused(request,"conflict","source inventory already sealed");
            String sourceCut=fresh?hash(cut+'\0'+storage+'\0'+version+'\0'+request.attempt()):old.sourceCut();
            long total=fresh?0:old.total(), count=old==null?0:old.count();
            Slice slice=scan(data,fresh?"":old.after(),workDeadline,clock);
            for(Row row:slice.rows()) {
                deadline(workDeadline,clock); Node identity=uri(header.getURI()+":claim:"+hash(row.claim()));
                Set<Quad> existing=record(data,STATE,identity,4,MAX_WITNESS_BYTES); deadline(workDeadline,clock);
                if(!existing.isEmpty()) {
                    if(!existing.equals(Set.of(new Quad(STATE,identity,p("inventoryJob"),header),new Quad(STATE,identity,p("claim"),uri(row.claim())),new Quad(STATE,identity,p("claimHead"),uri(row.head())),new Quad(STATE,identity,p("witness"),literal(row.witness()))))) return refused(request,"invalid","previously inventoried source changed");
                    if(!data.contains(STATE,directory(request.job()),p("claimFoldInventoryMember"),identity)) return refused(request,"invalid","previous member directory pointer unavailable");
                } else {
                    data.add(STATE,identity,p("inventoryJob"),header); data.add(STATE,identity,p("claim"),uri(row.claim()));
                    data.add(STATE,identity,p("claimHead"),uri(row.head())); data.add(STATE,identity,p("witness"),literal(row.witness())); count=Math.addExact(count,1);
                    data.add(STATE,directory(request.job()),p("claimFoldInventoryMember"),identity);
                    construction=new Construction(Math.addExact(construction.count(),1),xor(construction.hash(),memberHash(row)));
                }
            }
            total=Math.addExact(total,slice.rows().size());
            if(slice.eof() && total!=count) return refused(request,"invalid","previously inventoried source disappeared; cannot seal");
            Result pageResult=new Result("committed",slice.eof(),request.attempt(),request.page(),slice.after(),"",total,List.copyOf(slice.rows()),sourceCut,null);
            String hash=hash(JSON.toStringFlat(pageJson(request,pageResult)));
            Result result=new Result("committed",slice.eof(),request.attempt(),request.page(),slice.after(),hash,total,List.copyOf(slice.rows()),sourceCut,null);
            String payload=JSON.toStringFlat(resultJson(result));
            if(payload.getBytes(StandardCharsets.UTF_8).length>MAX_PAGE_BYTES) return refused(request,"invalid","inventory page exceeds byte bound");
            if(fresh) { data.add(STATE,attempt,p("sourceCut"),literal(sourceCut)); data.add(STATE,attempt,p("heldCut"),literal(cut)); }
            data.add(STATE,receipt,p("requestDigest"),literal(input)); data.add(STATE,receipt,p("inventoryResult"),literal(payload)); data.add(STATE,receipt,p("inventoryJob"),header);
            save(data,header,new Checkpoint(cut,request.attempt(),storage,version+1,slice.after(),Math.incrementExact(request.page()),total,count,hash,sourceCut,slice.eof()));
            saveConstruction(data,request.job(),construction);
            if(slice.eof()) sealDirectory(data,request.job(),sourceCut,hash,request.attempt(),construction);
            deadline(workDeadline,clock); data.commit(); committed=true; return result;
        } catch(InventoryDeadline expired) { return refused(request,"deadline","inventory deadline expired"); }
        catch(IllegalArgumentException invalid) { return refused(request,"invalid",invalid.getMessage()); }
        finally { try { if(!committed) data.abort(); } finally { data.end(); } }
    }

    private static Result retained(DatasetGraph data,Request request,Node receipt,String input,long deadline,Clock clock) {
        deadline(deadline,clock); Node stored=one(data,STATE,receipt,p("inventoryResult"),false); deadline(deadline,clock);
        if(stored==null) return null;
        Node digest=one(data,STATE,receipt,p("requestDigest"),true); deadline(deadline,clock);
        if(!text(digest).equals(input)) return refused(request,"conflict","inventory request identity differs");
        String payload=text(stored);
        if(payload.length()>MAX_PAGE_BYTES || payload.getBytes(StandardCharsets.UTF_8).length>MAX_PAGE_BYTES) throw new IllegalArgumentException("retained inventory page exceeds byte bound");
        Result replay=result(JSON.parse(payload)); deadline(deadline,clock);
        if(!replay.attempt().equals(request.attempt()) || replay.page()!=request.page() || !replay.hash().equals(hash(JSON.toStringFlat(pageJson(request,replay))))) throw new IllegalArgumentException("retained inventory page proof differs");
        deadline(deadline,clock); return replay;
    }

    /** This gate is staged for new exhaustive jobs only; accepted explicit partial policy is unchanged. */
    static boolean registered(DatasetGraph data,Job job) { return checkpoint(data,header(job))!=null; }
    static boolean requireSealed(DatasetGraph logical,Job job,String sourceCut,String hash) {
        try {
            DatasetGraph data=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical)); Checkpoint state=checkpoint(data,header(job));
            Clock clock=Clock.systemUTC(); return sealed(data,job,state,sourceCut,hash,clock.millis()+30_000,clock);
        } catch(IllegalArgumentException invalid) { return false; }
    }
    private static boolean sealed(DatasetGraph data,Job job,Checkpoint state,String sourceCut,String seal,long deadline,Clock clock) {
        deadline(deadline,clock);
        return state!=null && state.sealed() && state.sourceCut().equals(sourceCut) && state.hash().equals(seal) && state.storage().equals(incarnation(data))
            && expectedVersion(data,header(job),state)==version(data) && state.cut().equals(lineageCut(data,job,deadline,clock));
    }
    static boolean member(DatasetGraph data,Job job,Row row) {
        Node identity=uri(header(job).getURI()+":claim:"+hash(row.claim()));
        return record(data,STATE,identity,4,MAX_WITNESS_BYTES).equals(Set.of(new Quad(STATE,identity,p("inventoryJob"),header(job)),new Quad(STATE,identity,p("claim"),uri(row.claim())),new Quad(STATE,identity,p("claimHead"),uri(row.head())),new Quad(STATE,identity,p("witness"),literal(row.witness()))));
    }

    private static Slice scan(DatasetGraph data,String after,long deadline,Clock clock) {
        deadline(deadline,clock);
        if(data.contains(Quad.defaultGraphNodeGenerated,Node.ANY,RDF.type.asNode(),p("Claim"))) throw new IllegalArgumentException("default Claim storage cannot be inventoried as named CURRENT");
        deadline(deadline,clock);
        var tdb=TDBInternal.requireStorage(data); var index=(TupleIndexRecord)TDBInternal.findIndex(data,"GPOS").baseTupleIndex();
        var factory=new RecordFactory(32,0); var start=factory.createKeyOnly(); var end=factory.createKeyOnly();
        Node[] prefix={CURRENT,RDF.type.asNode(),p("Claim")};
        for(int i=0;i<3;i++) {
            var id=TDBInternal.getNodeId(tdb,prefix[i]);
            if(org.apache.jena.tdb2.store.NodeId.isDoesNotExist(id)) return new Slice(List.of(),"",true);
            NodeIdFactory.set(id,start.getKey(),i*8); NodeIdFactory.set(id,end.getKey(),i*8);
        }
        NodeIdFactory.setNext(TDBInternal.getNodeId(tdb,prefix[2]),end.getKey(),16);
        if(!after.isEmpty()) {
            byte[] key=HexFormat.of().parseHex(after);
            if(key.length!=32 || !Arrays.equals(Arrays.copyOf(key,24),Arrays.copyOf(start.getKey(),24))) throw new IllegalArgumentException("inventory cursor prefix differs");
            System.arraycopy(key,0,start.getKey(),0,32); increment(start.getKey());
        }
        List<Row> rows=new ArrayList<>(); String last=after; boolean eof=true;
        var tuples=index.getRangeIndex().iterator(start,end);
        try {
            int consumed=0;
            while(tuples.hasNext() && consumed<MAX_TUPLES) {
                deadline(deadline,clock); var tuple=tuples.next(); consumed++; deadline(deadline,clock);
                if(rows.size()==MAX_ROWS) { eof=false; break; } // lookahead counted, never checkpointed
                Node claim=tdb.getQuadTable().getNodeTupleTable().getNodeTable().getNodeForNodeId(NodeIdFactory.get(tuple.getKey(),24));
                rows.add(witness(data,claim)); deadline(deadline,clock); last=HexFormat.of().formatHex(tuple.getKey());
            }
        } finally { Iter.close(tuples); }
        deadline(deadline,clock); return new Slice(List.copyOf(rows),last,eof);
    }
    private static Row witness(DatasetGraph data,Node claim) { return witness(data,claim,CURRENT); }
    private static Row witness(DatasetGraph data,Node claim,Node descriptorGraph) {
        if(!nativeId(claim) || data.contains(Quad.defaultGraphNodeGenerated,claim,Node.ANY,Node.ANY)) throw new IllegalArgumentException("unsupported or mixed current Claim identity");
        Set<Quad> fields=record(data,descriptorGraph,claim,6,MAX_WITNESS_BYTES);
        Set<Node> allowed=Set.of(RDF.type.asNode(),p("referent"),p("interpretationContext"),p("propositionPredicate"),p("claimHead"),p("claimState"));
        if(fields.size()!=6 || fields.stream().anyMatch(q->!allowed.contains(q.getPredicate()) || !q.getObject().isURI())
            || !value(fields,RDF.type.asNode()).equals(p("Claim")) || !value(fields,p("claimState")).equals(p("Active")) || !nativeId(value(fields,p("claimHead")))) throw new IllegalArgumentException("malformed current Claim descriptor blocks inventory seal");
        Node head=value(fields,p("claimHead"));
        if(data.contains(Quad.defaultGraphNodeGenerated,head,Node.ANY,Node.ANY)) throw new IllegalArgumentException("mixed Claim head storage");
        Set<Quad> headFields=new HashSet<>(); Node revisions=uri(CommandPolicy.REVISIONS); int headBytes=0;
        for(Node predicate:List.of(RDF.type.asNode(),p("component"),p("modelRevision"),p("shapeRevision"),p("dataEpoch"),p("sequence"))) {
            var values=data.find(revisions,head,predicate,Node.ANY); int limit=predicate.equals(RDF.type.asNode())?2:1, seen=0;
            try { while(values.hasNext()) {
                if(seen++==limit) throw new IllegalArgumentException("ambiguous Claim head witness");
                Quad quad=values.next();
                // Account lexical scalars and the cumulative head before digit
                // validation, N-Triples formatting or hashing can copy them.
                headBytes=Math.addExact(headBytes,scalarBytes(quad.getPredicate(),MAX_WITNESS_BYTES-headBytes));
                headBytes=Math.addExact(headBytes,scalarBytes(quad.getObject(),MAX_WITNESS_BYTES-headBytes));
                headFields.add(quad);
            } }
            finally { Iter.close(values); }
        }
        Node sequence=value(headFields,p("sequence")), epoch=value(headFields,p("dataEpoch"));
        Node profile=uri("https://rezics.com/definition/claim-v1");
        if(headFields.size()!=7 || !values(headFields,RDF.type.asNode()).equals(Set.of(p("ClaimRevision"),p("RevisionAnchor")))
            || !value(headFields,p("component")).equals(claim) || !value(headFields,p("modelRevision")).equals(profile) || !value(headFields,p("shapeRevision")).equals(profile)
            || text(epoch).isEmpty() || text(epoch).length()>128 || !sequence.isLiteral() || !sequence.getLiteralLanguage().isEmpty()
            || !"http://www.w3.org/2001/XMLSchema#integer".equals(sequence.getLiteralDatatypeURI()) || !sequence.getLiteralLexicalForm().matches("[1-9][0-9]*")) throw new IllegalArgumentException("malformed Claim head witness blocks inventory seal");
        String witness=claim.getURI()+"\n"+head.getURI()+"\n"+String.join("\n",fields.stream().map(quad->NodeFmtLib.strNT(quad.getPredicate())+" "+NodeFmtLib.strNT(quad.getObject())).sorted().toList())+"\n"+String.join("\n",headFields.stream().map(quad->NodeFmtLib.strNT(quad.getPredicate())+" "+NodeFmtLib.strNT(quad.getObject())).sorted().toList());
        if(witness.length()>MAX_WITNESS_BYTES || witness.getBytes(StandardCharsets.UTF_8).length>MAX_WITNESS_BYTES) throw new IllegalArgumentException("inventory C/head witness exceeds byte bound");
        return new Row(claim.getURI(),head.getURI(),hash(witness));
    }

    private static String heldCut(DatasetGraph data,Job job) { Clock clock=Clock.systemUTC(); return heldCut(data,job,clock.millis()+30_000,clock); }
    private static String heldCut(DatasetGraph data,Job job,long deadline,Clock clock) {
        String cut=lineageCut(data,job,deadline,clock);
        // Only capture/restart probes the job's first two receipts. Subsequent
        // conversions use exact point receipts and never sweep all job receipts.
        deadline(deadline,clock); var receipts=data.find(RECEIPTS,Node.ANY,p("claimStatementFold"),uri(job.marker()));
        try { if(!receipts.hasNext() || !receipts.next().getSubject().equals(uri(job.acquireReceipt())) || receipts.hasNext()) throw new IllegalArgumentException("inventory must precede this job's first conversion"); } finally { Iter.close(receipts); }
        deadline(deadline,clock); return cut;
    }
    private static String lineageCut(DatasetGraph data,Job job,long deadline,Clock clock) {
        deadline(deadline,clock); var control=CommandInvariant.readControl(data); deadline(deadline,clock);
        if(control==null || !control.held() || !text(control.epoch()).equals(job.dataEpoch()) || !text(control.routing()).equals(job.routingEpoch())) throw new IllegalArgumentException("inventory owned held lineage unavailable");
        String marker="urn:rezics:maintenance:claim-statement-fold:"+hash("["+q(job.dataEpoch())+","+q(job.routingEpoch())+","+q(job.mapDigest())+","+q(job.job())+"]");
        String fence="{\"marker\":"+q(job.marker())+",\"mapDigest\":"+q(job.mapDigest())+",\"job\":"+q(job.job())+"}";
        String digest=hash("[\"claim-statement-fold-v1\",\"acquire\","+q(job.dataEpoch())+","+q(job.routingEpoch())+","+fence+"]");
        if(!marker.equals(job.marker()) || !job.acquireReceipt().equals(PREFIX+"acquire:"+digest)) throw new IllegalArgumentException("inventory job identity differs");
        Set<Quad> product=record(data,CONTROL,PRODUCT,32,16*1024); deadline(deadline,clock);
        Set<Quad> hold=record(data,CONTROL,uri(marker),2,2048); deadline(deadline,clock);
        Set<Quad> acquire=record(data,RECEIPTS,uri(job.acquireReceipt()),11,8192); deadline(deadline,clock);
        if(!values(product,p("restoreHold")).equals(Set.of(TRUE)) || !hold.equals(Set.of(new Quad(CONTROL,uri(marker),p("claimStatementFoldFence"),TRUE),new Quad(CONTROL,uri(marker),p("foldMapDigest"),literal(job.mapDigest()))))) throw new IllegalArgumentException("inventory cannot borrow an unrelated hold");
        Map<Node,Node> required=Map.ofEntries(Map.entry(RDF.type.asNode(),p("OperationReceipt")),Map.entry(p("commandFamily"),literal("claim-statement-fold-acquire-v1")),Map.entry(p("requestDigest"),literal(digest)),Map.entry(p("outcome"),p("Succeeded")),Map.entry(p("datasetId"),PRODUCT),Map.entry(p("dataEpoch"),control.epoch()),Map.entry(p("sequence"),value(product,p("sequence"))),Map.entry(p("claimStatementFold"),uri(marker)),Map.entry(p("foldMapDigest"),literal(job.mapDigest())),Map.entry(p("claimFoldJob"),literal(job.job())));
        if(acquire.size()!=11 || required.entrySet().stream().anyMatch(entry->!value(acquire,entry.getKey()).equals(entry.getValue())) || !text(value(acquire,p("claimFoldTemplateDigest"))).matches("[0-9a-f]{64}")) throw new IllegalArgumentException("inventory requires exact acquired job proof");
        deadline(deadline,clock); Set<Quad> stream=record(data,CONTROL,uri(CommandInvariant.MAIN_STREAM_SCOPE),8,8192); deadline(deadline,clock);
        return hash(canonical(product)+canonical(hold)+canonical(acquire)+canonical(stream));
    }

    private static void validate(Request request) {
        Job job=request.job();
        if(job==null || job.dataEpoch()==null || job.dataEpoch().isEmpty() || job.dataEpoch().length()>128 || job.routingEpoch()==null || job.routingEpoch().isEmpty() || job.routingEpoch().length()>128
            || job.mapDigest()==null || !job.mapDigest().matches("[0-9a-f]{64}") || job.job()==null || !job.job().matches("[A-Za-z0-9:_-]{1,128}")
            || job.marker()==null || job.acquireReceipt()==null || !uuid(request.attempt()) || !uuid(request.requestId()) || request.page()<0
            || request.previous()==null || !request.previous().matches("(?:[0-9a-f]{64})?") || request.deadline()<1) throw new IllegalArgumentException("invalid fixed Claim inventory input");
    }
    private static Checkpoint checkpoint(DatasetGraph data,Node header) {
        Set<Quad> fields=record(data,STATE,header,1,16*1024);
        if(fields.isEmpty()) return null;
        Node value=value(fields,p("inventoryCheckpoint"));
        try {
            JsonObject row=JSON.parse(text(value)); if(!s(row,"contract").equals(CONTRACT)) throw new IllegalArgumentException("inventory contract differs");
            if(!row.keys().equals(Set.of("contract","cut","attempt","storage","version","after","page","total","count","hash","sourceCut","sealed"))) throw new IllegalArgumentException("inventory checkpoint fields differ");
            Checkpoint state=new Checkpoint(s(row,"cut"),s(row,"attempt"),s(row,"storage"),n(row,"version"),e(row,"after"),Math.toIntExact(n(row,"page")),n(row,"total"),n(row,"count"),s(row,"hash"),s(row,"sourceCut"),row.get("sealed").getAsBoolean().value());
            if(!uuid(state.attempt()) || !state.cut().matches("[0-9a-f]{64}") || !state.sourceCut().matches("[0-9a-f]{64}") || !state.hash().matches("[0-9a-f]{64}")
                || !state.after().matches("(?:[0-9a-f]{64})?") || state.version()<0 || state.page()<1 || state.total()<0 || state.count()<state.total() || state.sealed() && state.count()!=state.total()) throw new IllegalArgumentException("inventory checkpoint values differ");
            return state;
        } catch(RuntimeException invalid) { throw new IllegalArgumentException("invalid native inventory checkpoint",invalid); }
    }
    private static void save(DatasetGraph data,Node header,Checkpoint state) {
        JsonObject row=new JsonObject(); row.put("contract",CONTRACT); row.put("cut",state.cut()); row.put("attempt",state.attempt()); row.put("storage",state.storage()); row.put("version",state.version()); row.put("after",state.after()); row.put("page",state.page()); row.put("total",state.total()); row.put("count",state.count()); row.put("hash",state.hash()); row.put("sourceCut",state.sourceCut()); row.put("sealed",state.sealed());
        data.deleteAny(STATE,header,p("inventoryCheckpoint"),Node.ANY); data.add(STATE,header,p("inventoryCheckpoint"),literal(JSON.toStringFlat(row)));
    }
    private static JsonObject requestJson(Request request) {
        Job job=request.job(); JsonObject row=new JsonObject(); row.put("contract",CONTRACT); row.put("dataEpoch",job.dataEpoch()); row.put("routingEpoch",job.routingEpoch()); row.put("marker",job.marker()); row.put("mapDigest",job.mapDigest()); row.put("job",job.job()); row.put("acquireReceipt",job.acquireReceipt()); row.put("attempt",request.attempt()); row.put("page",request.page()); row.put("previous",request.previous()); row.put("requestId",request.requestId()); row.put("deadline",request.deadline()); return row;
    }
    private static JsonObject pageJson(Request request,Result result) {
        JsonObject page=new JsonObject(); page.put("contract",CONTRACT); page.put("sourceCut",result.sourceCut()); page.put("attempt",result.attempt()); page.put("ordinal",result.page()); page.put("previous",request.previous()); page.put("rows",rowsJson(result.rows())); page.put("eof",result.sourceComplete()); page.put("next",result.next()); page.put("total",result.total()); return page;
    }
    private static JsonArray rowsJson(List<Row> rows) {
        JsonArray array=new JsonArray(); for(Row row:rows) { JsonObject object=new JsonObject(); object.put("claim",row.claim()); object.put("head",row.head()); object.put("witness",row.witness()); array.add(object); } return array;
    }
    private static JsonObject resultJson(Result result) {
        JsonObject row=new JsonObject(); row.put("status",result.status()); row.put("sourceComplete",result.sourceComplete()); row.put("attempt",result.attempt()); row.put("page",result.page()); row.put("next",result.next()); row.put("hash",result.hash()); row.put("total",result.total()); row.put("rows",rowsJson(result.rows())); row.put("sourceCut",result.sourceCut()); return row;
    }
    private static Result result(JsonObject object) {
        if(!object.keys().equals(Set.of("status","sourceComplete","attempt","page","next","hash","total","rows","sourceCut")) || !s(object,"status").equals("committed") || !uuid(s(object,"attempt"))
            || n(object,"page")<0 || n(object,"total")<0 || !e(object,"next").matches("(?:[0-9a-f]{64})?") || !s(object,"hash").matches("[0-9a-f]{64}") || !s(object,"sourceCut").matches("[0-9a-f]{64}") || object.get("rows").getAsArray().size()>MAX_ROWS) throw new IllegalArgumentException("invalid retained inventory page");
        List<Row> rows=new ArrayList<>(); for(JsonValue value:object.get("rows").getAsArray()) { JsonObject row=value.getAsObject(); if(!row.keys().equals(Set.of("claim","head","witness")) || !nativeId(uri(s(row,"claim"))) || !nativeId(uri(s(row,"head"))) || !s(row,"witness").matches("[0-9a-f]{64}")) throw new IllegalArgumentException("invalid retained inventory row"); rows.add(new Row(s(row,"claim"),s(row,"head"),s(row,"witness"))); }
        return new Result(s(object,"status"),object.get("sourceComplete").getAsBoolean().value(),s(object,"attempt"),Math.toIntExact(n(object,"page")),e(object,"next"),s(object,"hash"),n(object,"total"),List.copyOf(rows),s(object,"sourceCut"),null);
    }
    private static Result refused(Request request,String status,String error) { return new Result(status,false,request.attempt(),request.page(),"","",0,List.of(),"",error); }
    private static String s(JsonObject row,String key) { return ProfileRegistry.required(row,key); }
    private static long n(JsonObject row,String key) { return new java.math.BigDecimal(row.get(key).getAsNumber().value().toString()).longValueExact(); }
    private static String e(JsonObject row,String key) { JsonValue value=row.get(key); if(value==null || !value.isString()) throw new IllegalArgumentException("inventory string field differs"); return value.getAsString().value(); }
    /** Imported identities use JSON.stringify bytes, not Atlas's spaced flat writer. */
    private static String q(String value) {
        StringBuilder result=new StringBuilder("\"");
        for(int i=0;i<value.length();i++) {
            char ch=value.charAt(i);
            switch(ch) {
                case '"' -> result.append("\\\""); case '\\' -> result.append("\\\\");
                case '\b' -> result.append("\\b"); case '\f' -> result.append("\\f"); case '\n' -> result.append("\\n"); case '\r' -> result.append("\\r"); case '\t' -> result.append("\\t");
                default -> { if(ch<32 || Character.isSurrogate(ch) && !(Character.isHighSurrogate(ch) && i+1<value.length() && Character.isLowSurrogate(value.charAt(i+1))) && !(Character.isLowSurrogate(ch) && i>0 && Character.isHighSurrogate(value.charAt(i-1)))) result.append(String.format(Locale.ROOT,"\\u%04x",(int)ch)); else result.append(ch); }
            }
        }
        return result.append('"').toString();
    }
    private static Set<Quad> record(DatasetGraph data,Node graph,Node subject,int max,int byteLimit) {
        Set<Quad> result=new HashSet<>(); int bytes=0; var rows=data.find(graph,subject,Node.ANY,Node.ANY);
        try { while(rows.hasNext()) {
            if(result.size()==max) throw new IllegalArgumentException("inventory witness record exceeds fixed footprint");
            Quad quad=rows.next();
            scalarBytes(quad.getPredicate(),byteLimit-bytes);
            scalarBytes(quad.getObject(),byteLimit-bytes);
            bytes=Math.addExact(bytes,NodeFmtLib.strNT(quad.getPredicate()).getBytes(StandardCharsets.UTF_8).length+NodeFmtLib.strNT(quad.getObject()).getBytes(StandardCharsets.UTF_8).length);
            if(bytes>byteLimit) throw new IllegalArgumentException("inventory witness exceeds byte bound"); result.add(quad);
        } } finally { Iter.close(rows); } return result;
    }
    /** No Node.toString/formatter before these checks: literals can have huge
     * stored lexicals even when their datatype and apparent shape are valid. */
    private static int scalarBytes(Node node,int remaining) {
        if(remaining<0) throw new IllegalArgumentException("inventory witness exceeds byte bound");
        String[] parts;
        if(node.isURI()) parts=new String[]{node.getURI()};
        else if(node.isLiteral()) parts=new String[]{node.getLiteralLexicalForm(),node.getLiteralDatatypeURI(),node.getLiteralLanguage()};
        else throw new IllegalArgumentException("unsupported inventory witness scalar");
        int bytes=0;
        for(String part:parts) {
            if(part==null) continue;
            if(part.length()>remaining-bytes) throw new IllegalArgumentException("inventory witness scalar exceeds byte bound");
            bytes=Math.addExact(bytes,part.getBytes(StandardCharsets.UTF_8).length);
            if(bytes>remaining) throw new IllegalArgumentException("inventory witness exceeds byte bound");
        }
        return bytes;
    }
    private static Node one(DatasetGraph data,Node graph,Node subject,Node predicate,boolean required) {
        var rows=data.find(graph,subject,predicate,Node.ANY);
        try { Node value=rows.hasNext()?rows.next().getObject():null; if(rows.hasNext() || required && value==null) throw new IllegalArgumentException("ambiguous or missing inventory field"); return value; } finally { Iter.close(rows); }
    }
    private static Node value(Set<Quad> record,Node predicate) { Set<Node> values=values(record,predicate); if(values.size()!=1) throw new IllegalArgumentException("ambiguous or missing inventory witness field"); return values.iterator().next(); }
    private static Set<Node> values(Set<Quad> record,Node predicate) { Set<Node> result=new HashSet<>(); for(Quad quad:record) if(quad.getPredicate().equals(predicate)) result.add(quad.getObject()); return result; }
    private static String canonical(Set<Quad> records) { return String.join("\n",records.stream().map(q->NodeFmtLib.strNT(q.getSubject())+" "+NodeFmtLib.strNT(q.getPredicate())+" "+NodeFmtLib.strNT(q.getObject())).sorted().toList()); }
    private static String incarnation(DatasetGraph data) { var storage=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data)); synchronized(STORES) { return PROCESS+":"+STORES.computeIfAbsent(storage,ignored->UUID.randomUUID().toString()); } }
    private static long version(DatasetGraph data) { return TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data)).getTxnSystem().getThreadTransaction().getDataVersion(); }
    private static Node header(Job job) { return uri(job.marker()+":inventory"); }
    private static boolean uuid(String value) { return value!=null && value.matches("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"); }
    private static boolean nativeId(Node node) { return node!=null && node.isURI() && node.getURI().matches("https://rezics.com/id/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"); }
    private static String text(Node node) { if(node==null || !node.isLiteral() || !node.getLiteralLanguage().isEmpty() || !"http://www.w3.org/2001/XMLSchema#string".equals(node.getLiteralDatatypeURI())) throw new IllegalArgumentException("inventory string datatype differs"); return node.getLiteralLexicalForm(); }
    private static String hash(String value) { try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); } catch(java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); } }
    private static void increment(byte[] bytes) { for(int i=bytes.length-1;i>=0;i--) if(++bytes[i]!=0) return; throw new IllegalArgumentException("inventory physical key overflow"); }
    private static void deadline(long deadline,Clock clock) { if(Thread.currentThread().isInterrupted() || clock.millis()>=deadline) throw new InventoryDeadline(); }
    private static final class InventoryDeadline extends RuntimeException { private static final long serialVersionUID=1L; }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String name) { return uri(RV+name); }
    private static Node literal(String value) { return NodeFactory.createLiteralString(value); }
    private ClaimFoldInventory() {}
}
