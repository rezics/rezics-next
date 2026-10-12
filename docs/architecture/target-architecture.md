# REZICS 目標架構（草案 v0.2，2026-10-07）

這份文檔把兩輪架構審查的結論合成一份可以照著做的目標架構。凡是審查中「需要維護者決定」的問題，這裡**默認採用調研的傾向**；維護者只需劃掉不同意的條目。維護者的決定和少數仍需數據或實測的事項集中在第 13 節。論證、證據和外部先例是三輪架構審查的專題報告，存於本地分支 `archive/goals` 的 `architecture-review-2026-10-07/`（`arch-review-2/README.md` 與 `raw/`，以及第三輪 `arch-review-3/raw/`（B1 Jena 能力、B2 Jena 實測、B3 分類系統、B4 Jena 公開參考數據、C1–C4 語義網在各層的採用），本文只寫結論。

v0.1 的變更：分類改為系統能力（B3）；補入 Jena 原生能力的採用決定（B1）。

v0.2 的變更：
- 加入**漸近規模判準**：可以接受慢的引擎，不採用數學上無法擴展的形態。
- 加入**語義網分層圖**（C1–C4）。
- 用 B2 實測和 B4 公開數據更新容量；維護者定為「Jena 起步夠用」。
- 列出現存的**全站串行正確性依賴**，作為發佈前必須收斂的結構問題。
- 記錄維護者 2026-10-07 的決定（第 13 節）：逐步開放與平台權限、首發公開範圍、允許滯後、第三方 block 暫不開放。
- 加入呈現層設計，參考 `../reports/調研_json-render_系統.md`（第 8 節）。

---

## 0. 一頁摘要

1. **判準**：成本來自自研 API、自研抽象、自研存儲和自研版本機制；語義網詞彙和圖關係本身就是抽象，直接用。領域詞（Book、Recipe）出現在代碼裡不是問題。
2. **一個意義只有一種權威表示**：公開語義在圖裡，用標準 RDF；精確歷史 bytes 在對象存儲；正文、私有和運營數據在 Postgres；衍生投影可重建。
3. **瘦身圖**：圖裡只放當前公開語義和一個很小的提交證明。目標密度是每本書約 16 quads、每個章節約 8 quads，5 億業務實體約 44–54 億 live quads。
4. **引擎**：v1 用 Jena TDB2 單機，起步夠用。只有資格測試不過時，才用同一份瘦身表示和 Virtuoso OSS 比拼。QLever 以後作讀副本。不自研數據庫。
5. **版本**：accepted 表示「當前已審查基準」；只在語義真的改變時新增術語；block 和 component 各自帶版本；不保留任何兼容層。
6. **API**：通用資料 API + saved query + 少量具名任務 operation；不造全站 operation registry。
7. **Space / Realm / Zone**：Zone 是站點，Realm 是社群；開新 Realm 只因為要一個新社群。討論是 Realm 裡「關於某資源」的 thread。
8. **分類是系統能力**：貼的是 Resource 引用（主題），Concept 只用於詞彙分類；SKOS 分類體系由 Global、Zone、Realm、Organization、Person 共用和重用；Realm 在其上增加本地管理和「已接受收錄」篩選；版面 = 多值 tag + 可選主要版面。
9. **AI**：工程邊界固定，接受政策按實測品質演進；以發展的眼光看，不依賴尚不存在的能力保證正確性。
10. **多用 Jena 本身**：統計優化器、集合查詢（`VALUES`、`LATERAL`、property paths）、jena-text 直接索引外部文檔；不另造 Jena 已有的東西，也不引入會改變提交權威的組件。
11. **規模判準**：常數因子（單寫者、每次提交約 100ms、單機）可以接受，以後換引擎即可。成本隨全站數據量或總人數增長的形態直接排除，例如全站掃描、無界閉包、全站排序後取 LIMIT、全站串行點、開放查詢。每個操作只觸及一個有界鄰域。v1 不做分佈式，但不採用以後注定要推翻的形態。
12. **衡量架構，不衡量 API 數量**：在 AI 時代，operation 多寡不是成本的關鍵（764 個大約只會收斂到 540–620 個，多數承擔授權、金錢、發布、擦除等 owner 責任）。關鍵是架構：一個意義一種表示、每個操作有界、查詢和約束是標準數據、新增一個視圖或垂直只加查詢、shape 和 fixture，不加 handler。
13. **逐步開放**：需要打磨的能力都先關著，未開放的 operation 一律需要平台權限；開放一組能力只改它的公開狀態，不改代碼路徑（第 9 節）。首發公開書庫、食譜、VNDB 類、Bangumi 類，以及 Realm 和 Zone 的大部分能力。
14. **呈現層**：語義定義、能力、呈現 catalog 三者分開；「看哪些語義內容」用 read shape 決定，「畫成什麼」由 catalog 中有含義的元件決定；json-render 是可替換的渲染實作，不是持久化格式（第 8 節）。

### 語義網分層圖（C1–C4）

| 層 | 用什麼 | 決定 | 不用什麼（理由） |
| --- | --- | --- | --- |
| 詞彙 | schema.org、SKOS、PROV-O、AS2 + SIOC、ORG / schema `Role`、Web Annotation（證據定位）、DCAT / VoID、ODRL（權利交換） | 直接用；只保留少量本地謂詞（applicability、acceptance scope、revision pin、disclosure outcome） | — |
| 模型與約束 | **SHACL Turtle 作權威來源**，DASH / `sh:order` / `sh:group` 作欄位 metadata；Jena 解析和驗證 | 刪除 TS 寫的 SHACL DSL、accepted 凍結、通用 arbitrary 生成器；保留有限的 TS / TypeBox / JSON-LD 生成轉換器 | LinkML 作主來源（RDF 模型已在，會留下雙源）；ShEx 作第二驗證源；SHACLC 作權威（會丟 metadata） |
| 讀 | **已審查的標準 SPARQL 模板當作數據**，附參數 schema、響應 schema、scope、物理訪問資格和預算；資源讀用 CONSTRUCT + JSON-LD；grlc 只在建置期生成文檔 | 刪掉每種查詢都要一個 TS 分支、每個列表一個手寫 handler 的機制 | 公開任意 SPARQL、Graph Store Protocol、LDP 服務器、TPF、GraphQL-LD / HyperGraphQL（任意查詢工作量無界，或新增平行契約） |
| 寫 | 現有 Jena `CommandService` 執行器：受信任 input shape + Update 模板 + 局部 admission / CAS + focused SHACL + 同交易 receipt / outbox | 擴充既有執行器，不造新的通用命令引擎 | 用戶可上傳的 policy SPARQL；跨 owner 強一致交易 |
| 陳述與溯源 | `rdf:Statement`（已在用）；PROV-O 對外歸責；nanopub 只作可引用的導出包 | `rv:Claim` 第二套命題表示併入 Statement；刪除 Statement migration（374 行、3 個 operation） | RDF 1.2 triple terms 作主存儲（Jena 6.2 索引限制，B1） |
| 變更 | RDF Patch 作冷差分和導出 | receipt / outbox 保留命令結果；位置契約改為 stream-local | RDF Delta、全站 Patch log、從創世重播 |
| 推理 | 直接邊 + 有界 property path；小型封存詞彙可離線跑 reasoner | live dataset 保持 `NoEntailment`；`finite-rule` 的 join 可換 ARQ | 全站 RDFS / OWL RL 物化、OWL DL、`owl:sameAs` 推理 |
| 搜索 | jena-text 索引外部 entity documents（B1） | 移出圖中的搜索副本 | — |
| 授權 | 私有 Access（PostgreSQL）+ 有界 first-applicable policy；ReBAC 本身就是在關係圖上求值 | 公開的組織、版主、成員關係用 ORG / SIOC 描述；有效權限不由公開圖授予 | Solid WAC / ACP、ODRL 作執行、v1 引入 OpenFGA / SpiceDB |
| 身份 | `https://rezics.com/id/{uuid}`，不含 Realm 或 handle | 外部 WebID / did:web 作受驗證連結 | v1 改主鍵為 DID；`owl:sameAs` 合併外部身份 |
| 社交 | AS2 詞彙（Note / Article、Follow、Like、Mention、`inReplyTo`） | v1 只採詞彙 | v1 ActivityPub 聯邦（範圍和審核成本，不是不可擴展；開啟條件見 C3 §5.4） |
| 導入導出 | RIOT；分塊 N-Quads 快照；DCAT 描述；外部對齊存 external ID + 有證據的 correspondence，Concept 才用 `skos:exactMatch` | 外部 dump 只進隔離的 source scope，不直接 loader 進產品圖 | HDT 作權威備份；Quit Store / OSTRICH / R43ples 等歷史引擎 |
| 運維 | `riot`、`arq`、`shacl`、`rdfpatch`、`tdb2.tdbstats`、`tdbbackup`、`tdbcompact` 進 Task 和 CI | 新增工具時同步 `docs/development/toolchain.md` | 為一個 endpoint 換成整套 Fuseki UI server（現行 `server-plain` 沒有完整 Admin 模組） |

---

## 1. 設計判準

| 判準 | 含義 | 反例 |
| --- | --- | --- |
| 標準即抽象 | 先查 schema.org、LRM、BIBFRAME、SKOS、PROV-O、Web Annotation、SIOC 等；有答案就直接用 | 為 Book 和 Recipe 造一個更大的「通用 composition capability」 |
| 一個意義一種表示 | 同一份語義不同時存成 JSON/TS/SQL 又投影成 RDF | Structure qualifier 的 project/hydrate 雙向編解碼；Type 同時在 TS 和 SQL |
| 版本加在最小變化單位 | 加屬性、放寬約束不升版；block 改了只升 block | 加一種 slide 就升整份 `zone-presentation` |
| 一個字段一個角色 | 每種關係一個字段或謂詞 | `defaultRealm` 同時是品牌、站點範圍、解讀、討論來源 |
| 行為在 owner 裡 | 持久化步驟、資料選擇由 API 決定 | 瀏覽器編排發帖補償；展示 package 是否執行決定讀哪個 position |
| 成本隨變化量 | 熱路徑的工作量隨請求和變更大小增長，不隨全站規模 | 讀時重算、全量審計、從零重播、前綴重掃 |
| 漸近可擴展 | 假設將來必須水平分區（以 Meta TAO 規模的十倍來想）：每個讀、寫、驗證、授權、推理、擦除只觸及有界鄰域，成本約為「變更量 × log N」；跨分區效果異步傳遞。慢引擎可以換，形態不能推翻 | 全站 sequence 作正確性條件；全站排序後取 LIMIT；無界 `*` 閉包；寫入扇出到全部 followers；每次寫入全站重驗；OWL DL；只靠 timeout 界定開放查詢 |
| 錨點不等於有界 | 一跳就可能有一億條邊；限制的是實際讀到的邊、候選、依賴和輸出，不只是跳數、focus 數或 `LIMIT` | 「有錨點」就批准的模板；focused SHACL 走 inverse path 掃全部反向依賴 |
| 工程邊界固定，政策可演進 | Access、CAS、交易、receipt、證據、撤回、恢復固定；誰自動接受、誰審核按實測放寬 | 把今天的人工流程或今天模型的弱點寫死 |
| 新垂直的驗收單位 | 新增了多少 module、表、endpoint、codec、profile 分支（目標都是 0） | 用「代碼裡有沒有領域詞」判斷 |

---

## 2. 數據放置與表示

| 數據 | 放在哪 | 說明 |
| --- | --- | --- |
| 公開身份、名稱、跨域關係、Statement、qualifier、分類體系、本地收錄結果 | **圖**（標準詞彙） | 只放當前狀態；這是跨域查詢的核心 |
| 精確 revision payload（Work、Structure、Post 等的完整狀態） | **對象存儲** | 按 digest 存；Postgres 存 component、revision、digest、predecessor 的定位 |
| 正文、草稿、媒體 | **Postgres（Content）** + 對象存儲 | 正文搜索用 jena-text 的外部 entity documents 直接索引原文，不再複製成 RDF literal；公開名稱和章節標籤的搜索投影同樣移出圖（每個名稱省 N+11 quads、每個 placement 省 3 quads），名稱本身仍在圖裡 |
| 完整 receipt、outbox | **原 owner（Postgres）** | 圖裡同交易只留一個小型提交證明（約 3–6 quads），完整記錄轉入 owner 後再退役熱證明；不能改成「圖提交後再寫 PG」 |
| 私有高頻狀態：principal、membership、follow、書架、閱讀進度、通知、session、運營計數 | **Postgres** | 不為每次互動產生圖 revision |
| ranking、推薦、Discovery、聚合、通知索引 | **可重建的衍生 owner** | 不把每代完整副本放回圖 |
| 公開 Type 定義（labels、層次、property） | **圖** | 從 TS registry + `access.admitted_type` 的雙源收斂；admission 和 receipt 留 Access |
| 公開 mod release / requirement / platform 關係、已發布的 revelation 關係 | **圖**（C4） | 目前以 SQL 為權威；solver 結果和私人閱讀位置仍留 PG |
| 排序索引、唯一性 reservation（如 `projection_frame_identity`） | **PG** | 是物理算法（B-tree seek），不是第二份公開語義；不因「也是邊」就搬進圖 |
| 擦除 journal、hold、副本清單 | **PG，獨立保管** | 舊備份恢復時不能讓 suppression 一起回退 |
| 未採用的外部來源圖 | **隔離的 source scope + PG staging** | 不自動混入 native 已接受的圖；來源自帶的 `owl:sameAs` 只在 source scope 保留 |

**目標密度**（候選，需實測）：

| 實體 | quads | 內容 |
| --- | ---: | --- |
| 純 metadata 的書 | 約 16 | type、名稱、作者、分類、identifier，加必要的 head 和 Structure 指針 |
| 普通章節 + 一次 placement | 約 8 | Post 4 + `schema:ListItem` 4 |
| 同一 Post 的額外 placement | 約 4–6 | 重用 Post |
| 被陳述或 spoiler 引用的章節座標 | 約 3–8 + 陳述 | 按需 |
| qualified Statement | 約 6–12 起 | `rdf:Statement` + head、scope、evidence |
| 普通貼 tag | 1 條本地關係 + 少量 head | 不走完整 Statement + 接受決策 |
| 爭議性、有獨立證據的分類 | 完整 Statement | 按需升級 |

**歷史**：精確歷史必須可追（pin、DefinitionRef、receipt 結果）；全歷史分析走冷讀或異步物化，不要求任意跨全歷史的 SPARQL。熱歷史按天數和 facts 數雙重封頂，具體數字按實測的 churn 定。

**章節**：保留稀疏的圖身份和 placement，因為 wiki、角色出場、spoiler、跨作品重用都會引用章節；只有純解析出來、無人引用的 outline 留在圖外。

---

## 3. 存儲引擎路線

| 角色 | 引擎 | 狀態 |
| --- | --- | --- |
| 主寫入庫 | **Jena TDB2**（v1 起步） | 維護者 2026-10-07 定為「起步夠用」；Virtuoso OSS 只在資格測試不過時比拼 |
| 讀副本 / 分析 | QLever | 主寫入資格完成後再加；exact history、權限、read-your-write 回主庫 |
| 付費備選 | GraphDB、Stardog | 有授權預算時 |
| 不採用 | Fluree（無合格 erasure、搜索與快照不匹配、BUSL）、自研數據庫 | — |

- **容量目標**：5 億業務實體，3 億兜底；做到 3 億仍拿不到投資就轉向。
- **本機實測（B2，1,000 萬 quads，數據全在內存）**：

  | 項目 | default graph | named graph |
  | --- | ---: | ---: |
  | 初始大小（bytes/quad） | 115 | 236 |
  | 經過寫入再 compact 後（bytes/quad） | 約 169 | 約 371 |
  | xloader 導入 1,000 萬 | 101 秒 | 145 秒 |
  | 單實體交易（TPS / p50） | 8.9 / 109ms | 7.2 / 134ms |
  | 每交易 256 章，同一本書（章/s） | 1,261 | 1,068 |
  | 每交易 256 章，分屬不同書（章/s） | 883 | 629 |
  | 有界讀取 p95 | 多數 5–35ms | 同左 |

  - **約 100ms 的提交時間幾乎全是 durable sync**：每次提交 26–32 次 fsync、約 98% 時間在等同步。繞過 HTTP 用嵌入式 TDB2 只快幾毫秒。
  - **加 writer 不增加吞吐**，只增加排隊延遲。Jena 6.2 沒有安全的 group commit 選項；可行的手段是把同一業務任務合併成一次提交。
  - **持續寫入後空間會膨脹**：TDB2 是 copy-on-write，空間要計入 compaction 週期。
  - **冷緩存（cgroup 限制頁緩存，B2）**：
    - **拐點看緩存比例，不看規模**，落在約 20–25% 到 10% 之間，退化只發生在兩種形態上：
      - 2,679 章長篇的末段分頁：p95 從約 18ms 升到 500–650ms；
      - 熱門分類按時間排序：p95 從約 30ms 升到 700–800ms，每次上千次缺頁。
    - 其他有界查詢（書的屬性、作者的書、章節第一頁、章節數、作者各書最新章）在緩存只剩 5% 時，p95 仍在 15–55ms。
    - 現在的章節續頁雖然已用 keyset、沒有 OFFSET，但仍要遍歷、過濾、排序大量章節，**不是真正只讀 20 筆的 seek**，已列入第 10 節。
    - 緩存受限時的寫入：單實體 default 7–9 / named 4–7 TPS；每交易 64 章 default 284–326 / named 197–243 章/s。
    - 本機 NVMe 4K 隨機讀約 75µs（QD1）。
  - **外推（以實測緩存曲線為準，非實測）**：
    - 256GB 主機、44 億 quads：default 緩存約 27%，長篇末段和作者最新章 p95 約 58 / 30ms；named 緩存約 12%，約 300 / 50ms。熱門分類排序要 22–115 秒，不能用於互動請求。
    - 容量候選（前提是熱門排序改為投影）：256GB / default 約 20–44 億 quads（2,273–5,000 萬書加 2–4.5 億章）；本機 / default 5–10 億 quads。本機放不下 5 億業務實體：default 整理後約 742GB，兩代並存至少 1.48TB。
  - **當前事實優先放 default graph**：初始和整理後的 bytes/quad 都約為 named 的一半，每次提交也少約 6 次 fsync。需要連同 command、SHACL、text 的 graph 範圍一起資格驗證，不能直接把現有 current 切換過去。
- **公開參考數據（B4）**：
  - TDB2 有導入 163–167 億 triples 的記錄（512GB 內存，87–104 小時）。
  - ESWC 2023 在 163 億 triples 上實際跑了 328 條查詢；Freiburg 2025 在約 80 億 triples 上做了測量。
  - **大規模持續寫入沒有公開先例**：最大的讀寫混合 benchmark 只有約 3,500 萬 triples。
  - Wikimedia 2025–2026 選型時，Jena 未能導入 Wikidata。
  - 判斷：存得下、查得動，有證據；大規模持續寫入要自己資格。
- **起步含義**：
  - 單實體寫入約 7–10 TPS，正好卡在「每秒 10 個 graph command」的 SLO 草案邊上。
  - 經 API 導入 1 億實體，若逐個提交需要 116–145 天；要靠既有的 128 項批量提交（目前只覆蓋 catalogue import）在 24–48 小時內完成，約需每秒 580–1,160 個實體。批量曲線顯示這可以做到。
- **比拼方法**（僅在需要時）：同一份瘦身 N-Quads 交給兩個引擎；候選引擎必須在同一個 durable 交易裡完成 preflight、CAS、policy、update、post-state 不變量、focused SHACL 和投影，「驗證成功才提交」；需要維護私有 fork 的候選直接淘汰。
- **SLO 草案**：常見有界讀取 p95 ≤ 300ms；一般編輯 command 端到端 p95 ≤ 1s；第一個混合負載資格每秒 10 個 graph command；1 億初始 corpus 經 API 導入 24–48 小時；一致性備份恢復 ≤ 8 小時；完整重建 ≤ 48 小時。
- **硬件起點**：256GB RAM + NVMe 做 1 億到 5 億的資格。
- **寫入路徑**：把同一個業務任務合併成一次 commit（現在一個 Work 發布是 5 次）；解析、上傳、模型推理放在 writer 之外。
- **不做**：不按領域、語言、Zone 預先分片；不建分佈式事務層；不為假想規模預造 shard registry。

### Jena 原生能力的採用（B1）

REZICS 已經深入使用 Jena 的交易、Fuseki 模組、ARQ 擴展函數、jena-text 的 CJK 分析器和 focused SHACL；`VALUES` 已用在 147 個文件裡。下表是補齊和不採用的決定：

| 能力 | 決定 |
| --- | --- |
| `tdb2.tdbstats` / `stats.opt` 統計優化器 | **採用**；導入和分佈變化後刷新；引擎比拼時 Jena 必須開著它 |
| `VALUES`（含 tuple）、`LATERAL`、有界 property paths、`CONSTRUCT` | **採用**，推廣到仍逐項查詢的地方（例如書架評分一頁 48 次確認 → 1 次）；優先於自寫 TS 的 closure 或緩存 |
| jena-text 外部 entity documents | **採用**；需要約 200–400 行 producer 和重建交接，不是改配置就行；TDB2 與 Lucene 的提交不是 crash-atomic，保留 generation 證明 |
| Explain、query timeout、`/$/metrics` | **採用**作診斷；timeout 只是防禦，不能代替局部成本證明 |
| RDF Patch | **採用**作離線差分和冷歷史的差分格式；不代替 exact revision payload、receipt 或 CloudEvents |
| RDF 1.2 triple terms | **v1 不作主存儲**：每條陳述能省 3 quads，但 Jena 6.2 對內含變數的 triple term 不走普通索引，按主題查陳述可能退化成掃描；另做獨立資格實驗 |
| RDF Delta、Fuseki Kafka connector | **v1 不採用**：會改變提交權威、增加服務 |
| 全站 RDFS/OWL 推理、通用規則引擎 | **不掛在 live dataset 上**；小詞彙圖可用；`finite-rule.ts` 的求值內核可換成 ARQ |
| GeoSPARQL 空間索引 | **不用於動態位置**（索引建好後不能增量），保留 GeoSPARQL 詞彙，動態空間查詢用 PostGIS 投影 |
| Fuseki dataset/endpoint ACL | 只作內部的粗粒度隔離；`jena-fuseki-access` 只支持唯讀 dataset，`jena-permissions` 在 Jena 6 已移除，產品授權仍由 Access 判斷 |
| SHACL | 靜態的枚舉、基數、**有界的** post-state 約束移進 shape；前後狀態、CAS、receipt 留在 Java；涉及全站人口或無界反向引用的約束不進熱路徑 |
| Fuseki Admin（`/$/backup`、`/$/compact`、`/$/stats`） | 現行 image 是 `server-plain`，沒有完整 Admin 模組（C4）；v1 沿用離線 wrapper，需要時只接入有限的私有維護模組 |

---

## 4. 版本與演進

- **accepted = 本次已審查的當前基準**，允許同一變更更新或刪除；不可變的是已保管的快照（artifact digest、receipt、DefinitionRef）。`worker.md` 和 `model-profile-validation.md` 同步改。
- **四種版本分開**：格式版本（極少變）、內容 revision（每次編輯）、發布 revision（站點上線）、不可變快照。
- **升版規則**：

  | 變更 | 處理 |
  | --- | --- |
  | 加可選屬性 | 重用標準 predicate 或新增穩定 IRI，更新當前 shape，**不升版** |
  | 放寬約束 | 更新當前 shape，**不升版** |
  | 收緊約束 | 新的約束 artifact revision + admission 覆蓋檢查，不換 class IRI |
  | 同一 predicate 要表示不同意思 | **新增術語** |
  | 不同但都有效的用途 | 按用途命名的 shape，不叫 v1/v2 |
  | block / component 的 payload 改變 | 只升該 block |

- **未發佈期間**：每個家族收斂為唯一當前定義；每個 owner 一份基線 schema，重建 seed 和 fixture；刪除所有兼容層、dual-read、migrate/cutover API、啟動回填、舊 URL 語法。
- **發佈之後**：已發佈快照不可改，當前定義單調演進；term IRI 不偷換意思；只在真實客戶端需要時，在少數 API/JSON 邊界加局部 converter。
- **package 算法**：普通讀取返回封存結果並驗證 bytes；重新執行當時的 solver 作為明確的 audit 能力，不作默認。

**模型來源與生成物（C2）**：

| 對象 | 決定 |
| --- | --- |
| 圖約束的作者來源 | SHACL Turtle（現有 134 個 profile、323 個 NodeShape 已生成為 Turtle）；刪除 `model/compiler/ir.ts` 的 TS→SHACL DSL（222 行） |
| accepted 凍結 | 刪除 `generate.ts:128–199` 的 append-only 鎖（73 行）和 134 + 18 份手寫 digest；保留 artifact digest、manifest 和生成 drift 檢查 |
| 合成 arbitrary | 刪除通用 pattern 字典（89 行）；改用有目的的正反 fixture，避免用同一份 shape 生成數據再驗證自己 |
| 退役的 `packages/model/src/document.ts` | 刪除（159 行） |
| TS 類型、TypeBox、JSON-LD context | 保留有限的生成轉換器，改為讀 RDF terms；SHACL 不決定 JSON 的 container、null 和精確 lexical。實驗中現成的 SHACL→TS 工具會漏掉 `sh:in`，還把 IRI 當字符串，所以不採用 |
| 表單 | 欄位的 label、order、group、widget 用 `sh:name` / `sh:order` / `sh:group` / DASH；通用進階表單整合 shacl-form；Studio、Showcase 等任務畫面保留手寫，只共用欄位 metadata |
| 編輯器 | ProseMirror schema 保留；`extensionBlock` 的 shell 由 SHACL 約束，每個 block definition 的 payload 有自己的 shape 和版本（實驗：`rdf:JSON` 不驗證內部結構，payload 必須有自己的 schema） |
| Zone presentation | 刪除兩份只驗 marker 的 `zone-presentation-v{1,2}` 和平行頁面格式；showcase、shelf 等各自成 block |
| 版本單位 | term IRI 穩定；每個 shape 有穩定 IRI，artifact 有自己的 revision 和 digest；每個 block payload 各自演進；UI metadata 的調整不算語義改版。`owl:versionIRI` 只用於整個 ontology 的發佈 |
| CI | Jena `shacl validate`，檢查 report 的 `sh:conforms`（CLI 在不合規時 exit code 仍是 0）；沒有 focus 的「通過」不算通過 |

---

## 5. 寫入與 API

**三層**：

| 層 | 內容 |
| --- | --- |
| 資料層 | Resource 的當前 / revision / 批量讀取；普通屬性、Statement、關係、有序成員的編輯（server 選 shape 和權限，SHACL 驗證） |
| 查詢與表示層 | saved query 執行、CONSTRUCT 投影、JSON-LD framing、summary 和一個通用的 resource page facade |
| 任務層 | 授權、身份、發布、治理、金錢、外部取得、求解、擦除、恢復；具名、可授權、可恢復 |

**判斷一個操作在哪層**：只是記錄資料 → 資料層；產生 authority、接受立場或外部效果 → 任務；需要原子維持多個物件或 owner 的不變量 → 任務；只是「範圍 + 條件 + 排序 + 字段」的讀取 → saved query；包含算法、私有狀態或跨 owner 一致性的讀取 → 保留有界 facade；新增描述性領域要求新增 handler → 拒絕。

- 「API operations define backend behavior」不變：generic edit、query execute、publish 本身就是 operation。
- transport metadata（bearer、idempotency、rate family、MCP disposition）寫在 route 宣告旁邊，生成其餘清單；**不造執行一切的 operation registry**。
- 瀏覽器不編排持久化：發帖、回覆、建立社群各是一個可重試的 operation，重用既有 receipt。
- saved query 允許有界、經審核的標準 SPARQL，先限受信任作者和公開數據；同步修正 `platform-thesis.md:168`。
- 收斂的優先對象是重複的授權、重複的業務行為、客戶端持久化編排和昂貴的請求圖；薄 wrapper 可以保留，不按 endpoint 數或代碼行數判斷。

**接口細節（C1）**：

| 項目 | 決定 |
| --- | --- |
| 查詢模板 | 標準 SPARQL（`.rq` / CONSTRUCT），經 `/v1/query` 以 query IRI + revision + typed 參數執行；附參數 schema、響應 schema、scope、物理訪問資格和預算。取代 `query/compile.ts` 的六種 TS 分派（699 行中約 450–600 行可退） |
| 參數注入 | 不依賴 `ParameterizedSparqlString` 防注入（官方說明它是文字替換）；參數按 RDF term 類型綁定 |
| 資源讀 | server 選定的 read shape → CONSTRUCT → 固定 context 的 JSON-LD；framing 可選，只用於已授權的有限圖。普通請求不抓取遠端 context |
| 列表響應 | SELECT 型列表保留 typed JSON；類型從明確的響應 schema 生成 OpenAPI 3.x，不從 SELECT 變數名推導 |
| 寫入 | 普通屬性、有限 qualified record、分類成員、關係參與走「input shape + Update 模板 + 既有策略」；codec、結構算法、authority、審核、發布、金錢、擦除保留代碼 |
| 預算（初始值） | 每批 roots ≤ 64；每頁默認 20、最多 64；一般讀最多 2 跳、候選最多 256；排序必須有 seek 路徑；精確 count 讀已維護的 metric，否則返回下界或異步任務 |
| ETag | 按所讀 owner、component 或視圖的提交版本，不按全站序號；有撤權、擦除或 spoiler 依賴的響應，先做 admission 再決定 304 |
| 對外 SPARQL | 首發不開；第二階段只開公開數據 + 已合格模板結構 + 無 Update / SERVICE |
| operation 數 | 不作目標（維護者：AI 時代 API 數量不是關鍵）。預計 764 → 約 540–620，只作參考；驗收看「第四個同類視圖是否只加 query、schema、fixture」 |
| 重複 transport | Recipe 的 create / change 等 3 個 wrapper 刪除，直接用 Composition owner |

---

## 6. 語義與分類

**術語**：

| 英文 / API | 中文 | 含義 |
| --- | --- | --- |
| `Resource` / `ResourceRef` | 資源 / 實體引用 | 通用身份 |
| `topics`（交換時 `schema:about`） | 主題 / 關於 | 內容所關於的 Resource，可以是遊戲、角色、作品群或 Concept |
| `Statement.subject` | 命題主語 | 命題的左端，不與主題混用 |
| `Concept` | 概念 | SKOS 詞彙值，只用於詞彙分類 |
| `speaker` | 發言者 | 誰提出陳述 |
| `actingSubject` | 操作身份 | 這次以哪個 Person/Organization 操作 |
| `applicability` | 適用範圍 | 命題在哪個 Work、continuity、位置、release 下成立 |
| `Context` | 解讀 Context | 用哪套 exact definition 理解 |
| `acceptance` | 接受範圍 | 誰接受 |
| `ContextSelection` | 解讀選用 | 選了哪個 Context revision，不接受任何內容 |
| `placement` | 本地收錄 | 某 Realm 收錄了哪個 exact revision |
| `ConceptScheme` | 分類體系 | 一套 SKOS 概念 |
| `Facet` / `Saved Filter` | 篩選維度 / 已存篩選 | 選結果；可構成版面、Home tab、聚合 |
| `name` / `alternateName` | 名稱 / 其他名稱 | 顯示與搜索 |
| `address alias` | 地址別名 | 唯一可路由的 key |
| `board` / `section` | 版面 | Realm 管理的篩選與收錄入口 + 政策 |
| `franchise` | 作品群 | canonical Collection |
| `narrative universe` / `continuity` | 敘事世界 | 與作品群、設定作品分開 |
| tag / tagging | 標籤 / 貼標 | 只作界面和互操作用語 |

「視角」是人類討論的總稱，不是數據類型：用戶視角 = speaker；Context 視角 = 按某 Context revision 解讀；Realm 版面視角 = 該 Realm 已接受的收錄 + 它選用的分類和篩選；Global 要說清是 Global 解讀、Global 接受還是全站公開範圍。新 API 用 typed 字段區分三種 Global，不接受裸 `context: "global"`。

**三種關係分開**：「關於某遊戲」是 topic；「被分類為新聞」是分類 application，讀取時經內容分類 Facet（Facet 本身不寫到內容上）；「被收錄到某版面」是 Realm 本地 placement。

### 共享分類能力（B3）

分類體系的建立、維護、重用、應用和查詢是 Main 的**共享系統能力**，不屬於 Realm。

| 對象 | 表示 | 說明 |
| --- | --- | --- |
| 分類體系 | `skos:ConceptScheme`，獨立、可重用的 Resource | 寫明目的、範圍、維護來源和生命週期 |
| 分類值 | `skos:Concept` | 可以屬於多個 scheme；hierarchy 不因 `inScheme` 而限定在某個 scheme |
| 主題 | 任意 Resource，`schema:about` / `dct:subject` | genre、形式、來源作品、角色保留各自的關係，不壓成一個 predicate |
| 分類 application | 對 exact target，經某個 predicate 使用某個 Concept | 不新建 `Application` 身份家族 |
| 採用與篩選 | 既有 Query / Saved Filter 引用一個或多個 scheme | 採用不轉移維護權，不等於 Context 選用或內容收錄 |
| 管理政策 | Access | 誰能維護、套用、移除、審核、鎖定 |

**誰可以維護分類體系**：Global、Zone、Realm、Organization、Person 都可以作為治理範圍，命令由有 representation 或 grant 的 Person/Organization 以 `actingSubject` 執行。維護一個 scheme 不授予其中他方 Concept 的 canonical 編輯權；Global 的公共整理權獨立。

**重用、擴展與覆蓋**：

| 意圖 | 表示 |
| --- | --- |
| 直接採用完整 scheme | Query / Saved Filter 引用它和選定的 revision，不建副本 |
| 採用並加本地詞 | 新建本地增量 scheme，本地 Concept `inScheme` 它，必要時 `skos:broader` 共用 Concept；使用方選「共用 scheme OR 本地 scheme」 |
| 維護獨立的子集或完整 KOS | 對選定的共用 Concept 增加本地 `inScheme`，不複製 labels |
| 不同 Concept 之間的對應 | SKOS mapping，按實際關係選 exact / close / broad / narrow / related；固定多級分類或 crosswalk 才用 XKOS |
| 不同顯示名稱 | Context preference revision，不寫第二個同語言的 canonical `prefLabel` |
| 不同判準 | exact DefinitionRef / Context；已構成另一個概念時建新 Concept 並 mapping |
| 不採用某個詞或某條 hierarchy | 篩選的選擇或 scoped acceptance/rejection，不刪原 scheme 的數據 |
| 排序、分組、導航 | Collection / Zone navigation，不製造假的 `broader` |

不用 `owl:imports` 實現採用或覆蓋（它沒有「本地優先」的語義，也不產生 membership）；不把所有來源無條件 union 成一張有效的分類圖，有爭議的 hierarchy 用 Statement + acceptance。

**多視角**：分類體系的目的、範圍、來源寫在它的 metadata 裡；誰提出用 speaker，用哪個判準用 DefinitionRef + Context，誰接受用 acceptance，同一 Concept 顯示別的名字用 Context preference。不新增 Perspective 類型。

**精簡關係還是 Statement**：判斷標準是這項貢獻需不需要獨立存在、撤回、支持、舉證和接受，不是「有沒有發言者」。作者編輯自己的分類集合、版主整理本地版面，用精簡的當前關係 + component revision + receipt；多位用戶各自提出、可分別撤回的分類，從一開始就是 Statement，不能等到爭議發生再補建。

**版本**：新增 Concept、label 或 membership 只改 scheme 的內容 revision，不升任何系統 profile 版本；consumer 停用某個詞只改自己的選擇，canonical steward 退休 Concept 是停止新用並保留舊引用；已發布的導航和受管版面 pin 採用的 revision，一般 discovery 跟 live head。

**模型**：
- Statement（speaker、subject、relation、definitions、value、qualifier、Context revision、evidence）與 acceptance 分開；不使用強制的 Scheme→Concept→Path→Expression→Sense 鏈，catalogue import 立即改寫 Statement + 接受決策。
- 名稱：Resource 的名稱和別名重用 `schema:name`/`alternateName`/SKOS labels，需要獨立審查時用 NameRecord；地址別名只負責路由；relation lexicon 只負責關係的方向和語法。
- 歧義：Wikidata 式 entity picker + 簡短描述；入口可預填默認並顯示可改；推斷只給候選。不加後綴的「蔚藍檔案」在跨媒體入口默認指作品群。
- 允許少量 REZICS 本地謂詞（applicability、acceptance scope、revision pin、disclosure outcome），它們在圖裡，不構成新的抽象引擎。

**陳述與溯源（C3）**：
- Statement 已經是標準的 identified `rdf:Statement`，非斷言式，不改表示。`meaningKey` 和 decision slot key 是有限字段的索引鍵，保留。
- `rv:Claim`（verification）是第二套命題表示，併入 Statement；precision、valid time、edition scope 和 exact target 要完整搬過去，不只是改字段名。
- 對外映射：speaker → `prov:wasAttributedTo`；寫入或發布活動 → `prov:Activity`，revision 用 `prov:wasGeneratedBy`；`actingSubject` → `prov:wasAssociatedWith`。只有真實的代理授權才寫 `prov:actedOnBehalfOf`。
- receipt、compact commit proof、PROV、RDF Patch、CloudEvents 各管一件事，互不替代：
  - receipt：冪等和命令結果；
  - commit proof：本地提交證據；
  - PROV：公開歸責；
  - Patch：數據差分；
  - CloudEvents：異步交付。
- 可交給 SPARQL 的計算有三類：對傳入的 exact targets 批次 join 本地和 Global 的 decision；在有限的 pinned Context chain 中選最近的有效 entry（最多 8 層）；一頁已選 ID 的 hydration。
- 不交給 SPARQL：對主語的全部陳述先 `GROUP BY` 再分頁；用 `NOT EXISTS` 把「看不見」當「不存在」。
- 實驗（一條 Statement 加一個 Realm rejection）：現行表示 44 quads；包 Web Annotation 48 quads；包 nanopub 50 quads。三者查詢結果相同，都不斷言 base edge。

---

## 7. Space、Realm、Zone

| 對象 | 負責 |
| --- | --- |
| Space | 穩定的公開身份和地址，可選的共用品牌 |
| Zone | 站點：路由、首頁和頁面、導航、population、theme、站點發布 |
| Realm | 社群：成員、團隊、版主、規則、分類選用與本地應用治理、版面、本地收錄、審核、申訴 |
| Post / reply | 作者、內容身份、修訂、主題、父帖、受眾約束 |

- **開新 Realm 只因為要一個新社群（社區定位不同）**，例如 linux.do 與 NodeSeek；成員、規則、團隊、版主、私有分區的差異都在同一個 Realm 內解決。SCP 各語言分部各有定位，各自一個 Realm；staff 協作是 Realm 內只對團隊可見的分區。
- `/r/{space}` 保留為社群入口（討論、規則、加入）；showcase、模板等站點功能移到 Zone。
- Zone 不依賴 Realm：站點組裝以 Zone 為入口，無 Realm 的 Zone 使用同一套 renderer；拆掉 `defaultRealm` 的多重角色，`/z/{space}/w/{work}` 不再要求 Realm adoption，official Zone 不強制 Realm。
- **討論**：Zone 掛接一個或多個 Realm（可以屬於其他 Space）；頁面討論 = 該 Realm 中 `about=<該資源>` 的 thread，可以有多個，第一次發言時才建立；不需要 discussion tag。關係直接用 SIOC（`host_of`、`has_container`、`reply_of`、`topic`）和 schema.org（`about`、`author`）。
- 允許沒有 `about` 的自由帖；作者可以明確授權把 public 的 Realm-origin 帖放到其他 Realm，private origin 保持限制。
- Follow 一個 Zone 沿用同 Space 的一個 Follow；外部 Realm 不自動跟隨或加入。
- Zone 的討論和引用模組保留作者的 Person 身份；一般 resource discussion API 補上 author。
- FixedSite 退休，host binding 歸 Zone，保留其 benefit admission 和 sparse selection 語義。

**Realm 在共享分類能力上的管理與版面**（分類能力本身見第 6 節）：
- Realm 選用一個或多個 scheme（包括全站的和其他方發布的），可以維護自己的增量 scheme。分類 profile 的約束：層次保持 DAG，`related` 可成網；alias、implication、合併、拆分、退休分開，implication 先只作查詢展開。
- Realm 的分類查詢 = 本 Realm 已接受的 exact placements ∩ 有效且已接受的分類條件 ∩ 用戶額外的篩選 ∩ Content/Access/disclosure admission。Zone 可以導航某個 Realm 維護的 scheme，但仍搜索自己的 population：**scheme 來源、內容母集合、解讀、接受方是四個獨立選擇**。
- 版面 = **多值 tag + 可選的主要版面**（每個 Realm placement 0 或 1 個）；版面的結果是 Saved Filter，有人工策展需求時用 Collection。版面可以掛在 Concept（news）或實體（蔚藍檔案）上，掛在實體上不授予該實體的編輯權或官方發言權。
- 受管理 tag 的策略目錄：開放描述、成員、團隊或個人限定、版主專用（作者能否移除單獨規定）、提案後審核、**移除後鎖定**（鍵 `(Realm, post, Concept)`，alias 和新 revision 不能繞過）、禁止某人使用、tag 級整理者、公告（發帖權和回覆權分開）、置頂、隱藏、退休。普通移除允許重新提案，鎖定要寫明理由和範圍。
- 權限擴充 Realm 現有的管理權限（apply、remove、lock、move primary category 等 action 加 Concept/版面 target scope），不另造 ACL；`broader`、mapping、implication 不繼承權限或可見性；tag 版主只處理自己那個 tag，刪正文、剔除、ban、擴大受眾、代表 Realm 發言都另行授權。
- 本地降級：移出版面、移除 tag、Realm 剔除、作者撤回是四種結果，各自只改自己的範圍，作者看得到是哪一種；「禁止再貼」記成本地 rejection 或 lock，不能回落到 Global。
- 私有版面：模型保留，分切片資格；正文、附件、計數、搜索、通知、歷史走同一個 Access admission，不能用隱藏 tag 實現。
- 跨 Realm 聚合：默認按共用 Concept 或已審核的 `exactMatch`；mapping 屬共享能力，來源與接受方顯式選取，Realm 可以提出；Realm 聚合只使用各 Realm 已接受的收錄，其他使用方選自己的母集合。

---

## 8. Zone 呈現

| 對象 | 表示 |
| --- | --- |
| 首頁、自訂頁、正文 | Content 的 `DocumentSnapshot`（Blocks profile），重用 Studio 的草稿、語言版本、revision、發布；編輯器 UI 可以是專用的 |
| Showcase、shelf、ranking 等組件 | `extensionBlock`，每個 definition 自帶 payload schema 和版本；未知 block 可保存、可導出，公開時顯示明確的 placeholder |
| theme | 獨立設定；可執行 code 的審批有獨立生命週期，rollback 不能讓已撤銷的審批復活 |
| 路由和 mount | 圖中穩定的 binding |
| navigation | 自己的有序樹；隱藏連結不等於刪除路由 |
| saved query、Collection | 引用精確 revision；結果保持 live，需要固定成員時用 captured Collection |
| 圖片 | 引用既有 Media Use |
| 作者文字 | Content language（開放 BCP 47）；短標題翻譯用帶語言的 metadata，整頁翻譯用 Content variant；八個 UI locale 只是編輯器的便利 |

- 保存頁面草稿不改 Zone head；站點發布 bundle 精確的頁面、路由、導航、theme、query revision。
- position/continuity 等資料選擇由 API 的讀取描述決定，不取決於展示 package 是否執行。
- campaign art 歸 Zone 或 campaign，Work art 歸 Work，Realm 保留社群用途。

### 呈現層（參考 `../reports/調研_json-render_系統.md`）

**三種登錄分開，但業務定義只有一份**：

| 登錄 | 內容 | 來源 |
| --- | --- | --- |
| 語義定義 | 資源、屬性、概念與含義 | 詞彙 + SHACL Turtle（第 4 節） |
| 能力 | 可用行為、前置條件、授權、結果、恢復 | operation 宣告和 Access（第 5、9 節） |
| 呈現 catalog | 元件如何呈現上述資料與能力 | 引用前兩者，**不重寫**行為和權限清單，也不另建一套「AI tools registry」 |

**選擇與呈現分開（Fresnel 的 lens / format）**：
- 「看哪些語義內容、按什麼順序」= server 選定的 read shape：SHACL node shape 加 `sh:order` / `sh:group` 和 DASH viewer 提示，經 CONSTRUCT 執行（C1）。同一個人物在作品 Wiki 和創作者目錄中可以用不同的 read shape，身份和事實不複製。
- 「畫成什麼」= catalog 元件，屬於前端，符合 backend one、frontend free。
- Fresnel 自己的查詢選擇不照搬：選擇仍經已審查的模板、Access 和預算。

**catalog 的主體是有含義的元件**，例如 ResourceSummary、QualifiedFacts、EntityCollection、ObservationComparison、EvidencePanel、CapabilityActions、DocumentView：
- EntityCollection 自帶分頁、完整列表入口、計數精度和失敗狀態；ObservationComparison 自帶測量定義、單位、來源、缺值和不可比較狀態。
- Stack、Text 這類低階積木只用於版面，不承載業務含義。
- 新的語義數據先用通用呈現；新元件作為代碼加契約提案，經建置、測試、審閱後進入下一版 catalog。

**持久化格式留在 REZICS 的內容契約裡**：
- 頁面中的視圖是 `extensionBlock`，payload 包含：saved query 的 id 和 revision、綁定（例如當前路由資源）、呈現種類、`resultMode`（`live` 或 `snapshot`）、fallback。
- json-render 的扁平 spec 只是渲染時的中間格式，以及 AI 生成草稿時的傳輸和預覽格式（SpecStream / JSON Patch），不作持久化格式，也不當作協作或發布協議。
- Document AST 和 UI spec 不合併。
- **live view**：固定查詢和呈現定義，讀當前可見數據，顯示更新時間。**snapshot view**：另存結果或來源 revision 證據，重讀時仍遵守當下的公開和撤權政策。

**AI 的位置**：
- 採用「先準備可信候選、再讓模型選擇」：系統按任務和當前權限準備已綁定數據和動作的候選元件；Agent 選擇、排列、提出修改；確定性驗證後預覽，經 revision 保存或發布。模型不自行填寫評分、作者、語言等事實。
- 自然語言建立的 Saved View 要產出可持續操作的控制元件（DynaVis 模式），分支可回溯（Data Formulator 模式）；相關條件必須綁到同一次出場或同一個 release。
- AI 成本放在建立、編輯、探索；**普通閱讀不調用模型**。

**安全與規模**：
- 動作分三級：本地狀態、授權讀取、業務寫入。串流預覽、初始填充、watcher 不得自動觸發業務寫入；確認介面不是模型可以刪除的普通插槽。
- 「schema 合法」不等於「可以執行」：每個動作仍經 owner API 重驗身份、目標、授權、前置條件和冪等。
- 不用 `visible: false` 代替數據範圍控制：私有數據不先送到瀏覽器或模型上下文。
- 一個頁面的所有元件共用一份預算，批次 hydration、查詢去重、明確分頁；不讓每個元件各發請求或無界展開關係。不支持或超預算的查詢不能顯示成「沒有結果」。
- 已發布描述、AI 草稿、用戶本地輸入分開保存；重新生成不能抹掉用戶已完成的輸入和進階條件。
- 第三方 block 暫不開放；以後開放可執行元件時，借鑑 Shopify Remote DOM 的隔離，並沿用 `custom-theme-execution.md` 的審核和撤銷信任鏈。

**驗收**看語義正確性、Advanced ↔ Simple 往返不丟資料、權限變更與回滾、上千筆數據完整遍歷、人類任務成功率和總成本，不看截圖和 token 數。基線是同樣有 AI 協助的專屬前端，而不是完全手寫。

---

## 9. 授權與身份（第一輪結論不變）

- 一個授權判斷入口：已發布的 policy（含 deny）、mandatory restriction、representation、grant、capability eligibility 在同一處判斷；decision API 是它的預覽；資源操作在 admission/claim 時重新執行。
- 管理權來自當前 stewardship 和 controller，不綁定原始 provisioning principal；creation receipt 只作來源證據。
- 所有影響有效 controller 的變更（包括停用 principal）都走同一個 continuity 不變量。
- 帳號：guardian 改為邀請、接受、可退出；帳號恢復撤銷或重新綁定舊 passkey 和 TOTP；claim 時重驗 grant 到期；email 類 target 預算在 Turnstile 通過後才消耗；刪除帳號是一個可查詢進度的 operation。
- Account 進程不直接寫 Main 的 Access 和 Relay 私有庫，改為提交有 receipt 的 operation。
- 平台管理員是可治理的 role assignment，不是不可替換的單例。
- 速率限制按 principal class 落實（已驗證搜索也計費，見第 13 節）；`service` class 只認已驗證的 workload principal。
- **公開描述進圖，有效權限留 Access（C3）**：
  - 「Alice 是版主」用 ORG / `schema:Role` / SIOC 描述，是公開陳述；「這個 principal 現在能以 Alice 操作這個資源」是 Access 的私有判斷。兩者不是同一命題，公開圖不授權。
  - policy 保留現有有界的 first-applicable 格式：16 條 mandatory、64 條 ordered、條件深度 8。
  - 每次求值只查索引：指定 principal、actingSubject、target，加一條 authority path 的 exact generations。確認某人的 membership 按 pair 查索引，不能先取出整個團隊。
  - 以後可以換成有 revision / causal consistency 的 relation-check backend（Zanzibar 類），policy 和 API 不變。
- **撤權**：先終止 episode、關閉新的 admission；下游 grants 按 cursor 異步清理，不要求同步改完才生效。
- **身份**：主鍵 `https://rezics.com/id/{uuid}` 已滿足「Person is a brand」；需要繼續做的是現任 controller 的交接，不是重建主鍵。
- **聯邦**：v1 不做 ActivityPub；AS2 詞彙先就位，開啟條件見 C3 §5.4。

**平台權限與逐步開放**（維護者 2026-10-07）：

| 項目 | 設計 |
| --- | --- |
| 開放狀態 | 每個 operation 在 route 宣告旁寫 `exposure`：`public`，或 `platform:<group>`；**未寫的默認關閉**。group 對應 `capabilities.md` 的能力家族，例如 commerce、events、agent-mode、saved-views、sparql、dataset-dumps、person-schemes、third-party-blocks；也可以按單個 operation |
| 使用權 | 關閉的 operation 只對持有 `platform:use:<group>`（或 `platform:use:<operationId>`）grant 的 principal 或 group 開放；這是 Access 的普通 grant，有 episode、到期和 receipt |
| 授權任意平台權限 | `platform:grant`：可以授予和撤銷任意 `platform:*` 權限。它本身也是 Access grant，走既有的 assignment ceiling 和 continuity 不變量；至少兩位持有者，是可治理的 role assignment，不是寫死的單例 |
| 兩道檢查 | 開放閘門回答「這個 principal 能不能使用這項尚未公開的能力」；資源 authority 回答「能不能對這個目標做這件事」；兩道都過才執行。現有 `platform-administrator.ts` 寫死的管理動作清單屬於後者，改由 grant 表達 |
| 開放一組能力 | 把該 group 的 `exposure` 改為 `public`，經審查合入；不刪 grant、不改代碼路徑、不另寫一套 feature flag 服務 |
| 文檔與界面 | 生成的 OpenAPI、SDK、MCP 依 `exposure` 標記或隱藏；前端讀一份有界的「本人已開放 group」摘要決定顯示，API 仍強制檢查；About 站按既定口徑呈現，產品內按真實狀態 |
| 規模 | 每次請求只比對 principal 的少量 platform grants 與 operation 的 group，按 grant generation 緩存；不隨用戶數或 operation 數增長 |

---

## 10. 性能與一致性（第一輪結論不變）

- 讀取和續頁的有效性綁定 owner 或集合自己的 revision，不綁定全站 graph sequence；普通單頁讀取不要求全站靜止。
- 寫入者 append 本地事實，排序和投影 watermark 交給 consumer；應用層沒有把獨立 owner 耦合起來的全局行、計數器或 fence。TDB2 本身是單 active writer，這一點保留，要求的是 writer 內的工作有界。
- 集合工作優先交給 ARQ（`VALUES`、property paths、`CONSTRUCT`），只有工作負載證明需要才另外物化。
- 增量維護統計和 coverage：評分統一到 additive components；搜索不在請求內審計全站；ranking 從既有 coverage 前進而不是從零重播；標籤索引按可 seek 的 checkpoint 續跑；Library fence 用 per-agent revision。
- 預算限制工作量，不只是輸出：`LIMIT` 和 timeout 之外，限制 join、迭代、重算和寫放大；超出時返回明確的 partial 結果和可前進的 continuation，不把預算變成產品上限。
- 從 pool 取連線有等待上限（`connectionTimeoutMillis`），持有 pool client 時不向同一 pool 借第二條連線。
- 合法數據不能毒化共用管線：寫入入口與投影消費者共用同一份可接受數據的定義；暫時不可投影的工作不阻塞其他 target。

**現存的全站串行正確性依賴（C1–C4 交叉發現，發佈前收斂）**：

v1 單機上它們都能工作，但都把「全站只有一個順序」寫進了產品語義，將來分區時必須推翻。現在還沒發佈，改契約最便宜。

| 位置 | 現狀 | 改為 |
| --- | --- | --- |
| `semantic/command.ts:215` | 每次寫入更新 `DATASET rv:sequence` | 只作單機診斷水位；成功證明用自己的 receipt 和 component revision |
| `semantic/generation-guard.ts:75–96` | prepared write 綁全站 `ModelComponent` head | 只綁該命令必要的 shape / owner basis |
| Context / Statement 讀取 | before / after 全站 graph position 檢查 | 選定 component heads 的依賴 token |
| outbox 位置 `{datasetId,dataEpoch,sequence}` | 一條全站 gap-free stream | 加 stream scope，禁止跨 stream 比較 sequence |
| cursor / read basis | 部分續頁綁全站序號 | 綁 owner、component 或集合 revision；無關寫入不使 cursor 失效 |

**現存的人口級查詢形態（同上）**：

| 位置 | 問題 | 改為 |
| --- | --- | --- |
| `event/queries.ts` | 讀全部 source 重建 histogram | 增量 bucket projection |
| `statement/subject-read.ts:287` | 主語全部陳述 `GROUP BY` / `ORDER BY` 後截頁 | 按 subject / predicate / meaningKey 的 seek 索引取頁 |
| `follows/recipients.ts` | 有輸出上限，但候選要 union、group、排序 | 持久 cursor、每批獨立提交 |
| `verification/store.ts:426` | SQL recursive walk，`LIMIT` 加在結果端 | 限制展開工作，超額返回 partial / continuation |
| `infra/jena/purge-tdb2.sh` | 每次擦除一個 revision 都複製整個圖 | 批次 maintenance campaign；suppression 先生效 |
| 熱門分類按時間排序（B2 的 Q4） | 候選隨全站書數線性增長；緩存降到 10% 以下時 p95 達 700–800ms（實測），44 億 quads 時要 22–115 秒（外推） | 預先排序的投影或有序索引 |
| 長篇的章節續頁（B2 的 Q2） | keyset 沒有 OFFSET，但仍要遍歷、過濾、排序大量章節；緩存降到 10% 以下時，2,679 章長篇的末段 p95 達 500–650ms（實測） | 按書和 position 的有序 seek，只讀一頁 |

---

## 11. AI

- **態度**：以發展的眼光看，不激進；2025-06 和 2026-10 的模型已不是同一物種，2030 年是新時代。所有能力和價格數字都是會過期的快照，記錄模型、數據、指標、日期和適用範圍。
- **固定的工程邊界**：Access、CAS、交易、receipt、來源證據、撤回、恢復；用戶內容不能成為 agent 修改規則、搬移私有內容或授予成員資格的指令。
- **可演進的接受政策**：草稿 → 審 mapping 加抽查 → 已資格的低影響、可補償工作在同一 owner API 下自動接受（隨機稽核、漂移降級）→ 高影響操作人工批准。資格綁定「任務 + 來源 + 語言 + 模型配置 + 證據流程 + 評估集 revision」，用既有的 method、digest、Observation 記錄。自動接受記為 policy-approved automation，不偽裝成人工審核。
- 模型可以作 reviewer/judge，但要獨立評估；generator 和 judge 不能自動視為獨立。
- 穩定的結構化來源優先產出可重用的 mapping；每條內容不同的抽取、翻譯、審核允許逐條推理。比較方案用「每個被接受結果的總成本」。
- 保存重評材料（來源 revision、證據、模型原始輸出、配置、verifier 結果、接受決策、評估集 revision）；新模型產生新判斷，不覆寫舊結果。
- 自動身份連結以 99.5% precision 為最低門檻，另按影響設 error budget。
- $10/月 inference 上限用完後按審核產能限流 intake；one-click wiki 是「一個動作啟動一份可審核的建站工作」。

---

## 12. 明確不做的事

- 不建通用 capability binding 框架、全站 operation registry runtime、通用 semantic fingerprint 或 SHACL 等價判定器、Zone population descriptor、萬用 Tag 身份類型。
- 不在 Zone 裡另造論壇；不為每頁、每個分區或每個團隊開 Realm。
- 不自研數據庫；不預先分片；不建分佈式事務層。
- 不保留未發佈期間的任何兼容層；不為「跨文件修改太多」保留永久 dual-read。
- 不讓每次請求或每次讀取依賴即時的模型裁決。
- 不在產品熱路徑開放任意 SPARQL、Graph Store 寫入或遠端 `SERVICE`；不在 live dataset 掛 RDFS / OWL 推理或 `owl:sameAs` 閉包。
- 不採 LinkML 作主模型、不加 ShEx 作第二驗證源、不採現成 SHACL→TS 工具的 mutable wrapper。
- v1 不做 ActivityPub 聯邦、Solid 身份與授權協議、DID 主鍵、通用 VC 發行；不引入 OpenFGA / SpiceDB、RDF Delta、Debezium、HDT 權威備份或第二個歷史引擎。
- 不承諾任意篩選的全站即時精確計數、全局最佳排序或整頁全局一致快照。

---

## 13. 決定記錄與剩餘事項

**維護者 2026-10-07 的決定**：

| 事項 | 決定 |
| --- | --- |
| 主寫入引擎 | v1 用 Jena，起步夠用 |
| 計數、排行、跨 section 一致性 | 論壇默認允許滯後；公共 count / rank 標 freshness，頁面各 section 可各自有 basis |
| API 數量 | 不是目標；衡量的是架構（一種表示、有界操作、標準即數據、新垂直零 handler） |
| 第三方 block | 暫不開放；catalog 只收第一方 block |
| 逐步開放 | 需要打磨的能力都先不開放，逐步完善、逐步開放；未開放的 operation 一律需要平台權限（每個或每組），並有一種能授予任意平台權限的平台權限（見第 9 節） |
| 首發公開範圍 | 書庫、食譜、VNDB 類（視覺小說）、Bangumi 類（動畫、漫畫、遊戲等條目與收藏），以及 Realm 和 Zone 的大部分能力；其餘按平台權限逐步開放。`docs/product/capabilities.md` 2026-09-30 的 cut lines 在拆回 owner 文檔時按此更新 |
| 社群關係的公開性 | 按最常見做法，且都可改：版主和團隊角色公開；成員數公開，成員名單對 Realm 成員可見（Realm 可改）；關注數公開，關注名單默認公開、用戶可隱藏 |
| 其餘 | 按最佳實踐設計（下表） |

**按最佳實踐默認**（維護者可劃掉）：

| 事項 | 默認 |
| --- | --- |
| 已驗證搜索計費 | 所有 principal class 都消耗讀和查詢預算，取消豁免（C1） |
| 發佈前保管的開發數據 | 只保管有作者價值、來源證據或被 exact 引用的材料，其餘按當前模型重建 |
| Person 發布被他方採用的分類體系 | 首發走平台權限，之後開放 |
| 全站默認導航 | 默認 Global 公共整理，進階入口可明確切換到他方整理 |
| 普通用戶替他人資源分類 | 用 Statement（可獨立撤回）；作者整理自己的內容、版主整理本地版面用精簡關係 |
| 公開 scheme 更新與已發布導航 | 導航和受管版面 pin revision，discovery 跟 live |
| 收緊描述性 shape 後的舊數據 | 照常顯示並標品質狀態；authority、隱私和核心結構不變量立即拒絕 |
| 品牌身份的跨平台遷移 | 首發不承諾。承諾的是在 REZICS 內跨 Realm / Zone 不變、controller 可交接、完整可讀導出；把身份連同關注者搬到其他平台繼續使用（類似 Bluesky 的帳號遷移）以後另做 |
| 擦除 | suppression 立即生效；活躍存儲 30 天內物理刪除；備份 90 天內過期，恢復時先重放擦除 journal；界面分開顯示 suppressed / retained / destroyed / blocked |
| 對外數據通道 | 首發公開範圍內：模板 API、有權限的 export、公開當前語義的 N-Quads 下載；受限 SPARQL、歷史 dump、訂閱更新走平台權限 |

**剩餘（需要數據或實測，不是設計取捨）**：

| # | 事項 | 誰來定 |
| --- | --- | --- |
| 1 | 5 億業務實體的人口組成：書、Edition / Release、章節、placement、語言版本、其他資源各多少，帶正文的比例 | 維護者提供；決定是 40 億還是 200 億 quads 量級 |
| 2 | 硬件預算，以及停寫維護、備份恢復、全量重建可接受的時間 | 維護者 |
| 3 | 熱歷史的天數和 facts 上限 | 實測 churn |

---

## 14. 落地順序

第一輪的安全和正確性問題（`archive/goals` 的 `architecture-review-2026-10-07/arch-review/README.md` 第四節第 1 步和第七節）不受影響，最先處理。之後按下表；每個切片都量成本（首次通過率、tokens、審查分鐘、返工、讀寫量），小切片仍需大量新框架就停下檢討。

| 順序 | 切片 | 驗證 |
| --- | --- | --- |
| 0 | accepted 改為當前基準；改 `worker.md`、`model-profile-validation.md`；採用新垂直的驗收單位 | 停止製造新 `-vN` |
| 1 | `relation-occurrence` 的 `creditedName` 併回當前 shape | 增量變更不產生新分支 |
| 2 | catalogue import 改寫 Statement + 接受決策 | 刪除一個雙重表示 |
| 3 | Collection 有序成員改 `schema:ItemList` + SHACL 數據，再配置「播客單集播放清單」 | 新垂直後端零新增代碼 |
| 4 | Recipe 的 create/change/read 改用既有 Composition operation | transport 收斂而不引入更大 runtime |
| 5 | 無 Realm 的 Zone 首頁：文字 + Showcase `extensionBlock`，存為 Content 文檔 | Zone 頁面文檔化、block 獨立版本、Zone 不依賴 Realm |
| 6 | 該 Zone 連到另一個 Space 的 Realm 中 `about=<Work>` 的 thread | 討論歸屬 Realm |
| 7 | 1,000 條記錄的固定來源：agent 生成 mapping，人審，確定性轉換經 API 提交，再用更強模型重評 | AI 產出 artifact、程式重用；總投入是否減半 |
| 8 | 瘦身表示的端到端薄切片在 Jena 上跑真實 command（CAS、policy、focused SHACL、receipt）；用現有 1 億多數據經 API 批量導入，逐級資格到 3 億、5 億；只有不過才引入 Virtuoso 比拼 | 起步容量與寫入路線；可與其他切片並行 |
| 9 | 同一套 Global scheme 同時被 Global、一個不依賴 Realm 的 Zone、一個 Realm 使用；Realm 加本地增量 scheme 和一個有兩個上位的本地 Concept、管理者專用詞、移除後鎖定；Zone 用 Global + Realm 本地的詞彙視圖導航但搜索自己的 population；一項需獨立撤回的分類用 Statement 並存 | 分類是系統能力、Realm 只加管理和篩選；新增抽象家族為 0，允許一個 `classification-changes` endpoint |
| 10 | 書架評分的 graph 確認從逐項 48 次改為一次 tuple `VALUES`；同時建立 `tdbstats` 的生成和刷新流程 | 「多用 Jena」的直接收益；0 新 API、0 新表、0 新 quads |
| 11 | **移除全站串行正確性依賴**：`rv:sequence` 降為診斷、generation guard 綁必要 basis、Context 讀改依賴 token、outbox 位置加 stream scope、cursor 綁局部 revision | 無關寫入不使 cursor 失效；讀取不依賴全站靜止；**規模判準的第一優先，發佈前做** |
| 12 | Post 的作者來源改為 SHACL Turtle，有限轉換器生成 TS / TypeBox；加一個只含 Work 引用和帶語言標題的 `extensionBlock` payload shape；在同一變更中加一個可選欄位 | 不產生新 profile 家族或文檔版本；之後遷移其餘 profile、刪 TS DSL 和 accepted 凍結 |
| 13 | `GET /v1/works/{id}/versions`、`adoptions`、`credits` 改為三份 SPARQL 模板（原型 53 行）+ 共用 adapter，撤去 `read-pages.ts` 等 134 行和 3 個 operation | **第四個同類視圖只加 query、schema、fixture，不加 handler**；首片可能淨增代碼 |
| 14 | 一個主語、兩位 speaker、同一 meaning、一個 Realm acceptance：有界 acceptance 讀取 + PROV 導出，刪除 Statement migration（374 行、3 個 operation） | 不合併不同 speaker；unavailable 不 fallback；私有 principal 不出現在 PROV |
| 15 | 一個有界 component 的冷差分 export：兩個已保管 revision → RDF Patch → 隔離 dataset 重放 | 錯誤的 base、缺失對象、已擦除 revision 都不被當成成功；工作量只隨該 component |
| 16 | `riot`、`arq`、`shacl`、`rdfpatch`、`tdb2.tdbstats`、`tdbbackup`、`tdbcompact` 進 Task 和 CI，同步 `toolchain.md` | CI 中的 query fixture 同時檢查無關人口增長和高 degree 錨點對工作量的影響 |
| 17 | 平台權限：route 宣告加 `exposure`、未寫默認關閉；`platform:use:<group>` 和 `platform:grant` 用既有 Access grant；把一個現已上線但未打磨的能力（例如 saved views）放到 group 後面 | 無 grant 時 operation 拒絕且 OpenAPI / MCP 標記；授予後可用；改 `exposure` 即開放；`platform:grant` 不能繞過 assignment ceiling |
| 18 | 呈現層第一片：一個只讀的 Resource 頁面，read shape（SHACL + `sh:order` / DASH）決定內容，三到五個語義元件組成小 catalog；普通前端和 json-render 適配兩條路徑讀同一份數據和查詢契約 | 語義、降級、分頁、權限、語言、性能兩條路徑一致；證明描述層值得存在之後，才加自然語言提案 |

定案之後，這份文檔的內容按「decisions live in docs」拆回各 owner 文檔：`docs/product/decisions.md`、`platform-thesis.md`、`docs/contracts/{classification,context,space,presentation,queries,standards,semantic-interoperability,commands,events-and-jobs,model-profiles,identity-and-access}.md`、`docs/architecture/overview.md`、`docs/storage/`、`docs/development/toolchain.md`、`docs/goals/worker.md`、`docs/implementation/model-profile-validation.md`；`.temp/` 下的審查報告只作證據保留。
