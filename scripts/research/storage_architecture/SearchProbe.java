import java.nio.file.*;
import java.util.*;

import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.query.*;
import org.apache.jena.rdf.model.*;
import org.apache.jena.system.Txn;

/** Disposable Jena 6.2.0 search dataset and loopback Fuseki endpoint. */
public class SearchProbe {
    static final String BASE = "https://example.test/search/";
    static final String GRAPH = "urn:search:public";
    static final String BODY = BASE + "body";
    static final String REALM = BASE + "realm";
    static final String[][] FIXTURES = {
        {"d1", "我在研究中文搜索功能"},
        {"d2", "今天討論中文搜尋方案"},
        {"d3", "Rust語言中文資料"},
        {"d4", "人工智能检索教程"},
        {"d5", "功能说明书"},
        {"d6", "青龍偃月刀"},
        {"d7", "圖書館藏書"},
        {"d8", "ＲＵＳＴ全角字母"},
        {"d9", "東京の検索エンジン"},
        {"d10", "한국어 검색 엔진"},
    };

    static String assembler(String root) {
        return """
            PREFIX tdb2: <http://jena.apache.org/2016/tdb#>
            PREFIX text: <http://jena.apache.org/text#>
            PREFIX : <https://example.test/asm#>
            :ds a text:TextDataset ; text:dataset :tdb ; text:index :idx .
            :tdb a tdb2:DatasetTDB2 ; tdb2:location "%s/tdb2" .
            :idx a text:TextIndexLucene ;
                text:directory "%s/lucene" ; text:entityMap :em ;
                text:storeValues true ;
                text:defineAnalyzers (
                  [ text:defineAnalyzer :cjkIndex ;
                    text:analyzer [ a text:ConfigurableAnalyzer ;
                      text:tokenizer :std ;
                      text:filters ( :width text:LowerCaseFilter :bigramUni ) ] ]
                  [ text:defineTokenizer :std ;
                    text:tokenizer [ a text:GenericTokenizer ;
                      text:class "org.apache.lucene.analysis.standard.StandardTokenizer" ] ]
                  [ text:defineFilter :width ;
                    text:filter [ a text:GenericFilter ;
                      text:class "org.apache.lucene.analysis.cjk.CJKWidthFilter" ] ]
                  [ text:defineFilter :bigramUni ;
                    text:filter [ a text:GenericFilter ;
                      text:class "org.apache.lucene.analysis.cjk.CJKBigramFilter" ;
                      text:params ( [ text:paramName "flags" ; text:paramType text:TypeInt ; text:paramValue 15 ]
                                    [ text:paramName "outputUnigrams" ; text:paramType text:TypeBoolean ; text:paramValue true ] ) ] ]
                ) ;
                text:analyzer [ a text:DefinedAnalyzer ; text:useAnalyzer :cjkIndex ] .
            :em a text:EntityMap ;
                text:entityField "uri" ; text:defaultField "body" ;
                text:uidField "uid" ; text:graphField "graph" ;
                text:map ( [ text:field "body" ; text:predicate <%s> ] ) .
            """.formatted(root, root, BODY);
    }

    static void add(Dataset ds, List<String[]> rows, String graph) {
        Txn.executeWrite(ds, () -> {
            Model m = ds.getNamedModel(graph);
            Property body = m.createProperty(BODY);
            Property realm = m.createProperty(REALM);
            for (String[] row : rows) {
                Resource s = m.createResource(BASE + row[0]);
                m.add(s, body, row[1]);
                if (row.length > 2 && "true".equals(row[2])) m.add(s, realm, "A");
            }
        });
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("root port workloadRows");
        Path root = Path.of(args[0]).toAbsolutePath();
        int port = Integer.parseInt(args[1]);
        int total = Integer.parseInt(args[2]);
        if (total != 10_000 && total != 50_000) throw new IllegalArgumentException("rows must be 10000 or 50000");
        Files.createDirectories(root);
        Path asm = root.resolve("assembler.ttl");
        Files.writeString(asm, assembler(root.toString()));
        Dataset ds = DatasetFactory.assemble(asm.toString(), "https://example.test/asm#ds");
        add(ds, Arrays.asList(FIXTURES), "urn:search:fixtures");
        List<String[]> batch = new ArrayList<>(1000);
        long loadStart = System.nanoTime();
        for (int id = 1; id <= total; id++) {
            boolean target = id > total - 5;
            boolean realm = id <= 512 || target;
            String body = target
                ? "中文" + "这是一段很长的补充说明文字用于降低相关度评分".repeat(8) + id
                : id <= 512 ? "其他内容第" + id + "篇" : "中文资料第" + id + "篇";
            batch.add(new String[]{"w" + id, body, Boolean.toString(realm)});
            if (batch.size() == 1000 || id == total) {
                add(ds, batch, GRAPH);
                batch.clear();
            }
        }
        long loadMs = (System.nanoTime() - loadStart) / 1_000_000;
        FusekiServer server = FusekiServer.create().add("/search", ds).port(port).build();
        server.start();
        System.out.println("READY " + port + " " + total + " " + loadMs);
        System.out.flush();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> { server.stop(); ds.close(); }));
        Thread.currentThread().join();
    }
}
