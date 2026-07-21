# v104七路影子預測千局迭代 Implementation Plan

> **For Hermes:** Use Codex/TDD task-by-task; Faker independently verifies RED/GREEN, security, DB, UI and Production E2E.

**Goal:** 在不改動正式v104 Active預測的前提下，建立莊閒主預測＋六項副預測的獨立Live Shadow、每千局圖表、每項千次出手權重建議與後台只讀呈現。

**Architecture:** 新增獨立`v104-seven-head-shadow-v1`資料面與feature flag。每局事前只發行一次不可變影子payload，內含7個head；權威Final後一次結算全部head、MT固定賠付、固定1單位及信心加權單位。正式Queue／ACK不得等待影子。每1,000個已Final影子局建立一份千局報告；主預測每1,000次、各副項每1,000次實際出手產生一份只調既有非零權重比例的建議。後台僅超管可讀，圖表使用無新依賴的SVG圖片。

**Tech Stack:** Node.js ESM、PostgreSQL/Supabase SECURITY DEFINER RPC、React/Vite、Node test runner、Vitest。

---

## 凍結契約

- 正式Active永遠是`v104`；Shadow不得寫`daily_prediction_results`、正式side actions或會員前台。
- 7個head：`main`（莊／閒綁定）、`tie`、`superSix`、`bankerDragon`、`playerDragon`、`bankerPair`、`playerPair`。
- 主預測每局強制選莊／閒；和局PUSH。六副項各自以正式v104既有門檻出手，彼此可同局同時出手；Shadow不套正式超六／龍寶主方向Gate。
- 第一代權重精確複製正式v104。權重key集合、名稱、意義、門檻、信心公式、賠付規則凍結；建議只能重分配同一head現有非零key的比例，合計1，不新增／刪除／改名。
- 主單位：信心<=50為1；50～70線性到5，Math.round，70以上封頂5，範圍1～5。副項：未達門檻0；門檻為1、100為10，Math.round。
- MT淨賠付：莊0.95、閒1、和8、超六12、對子11；龍寶天然勝或點差4為1、5為2、6為4、7為6、8為10、9為30；輸為負下注單位，PUSH為0。
- 每千局報告顯示出手率、命中率、固定1單位淨值、信心加權淨值（普通正負數，不加單位圖示），並輸出整張繁中圖表。
- 千次循環不拆70/30：目前版本完整1,000次產生建議；哥批准的新版本再重新從0跑下一個1,000次。系統只產生建議，不自動更換版本。

## Task 1：核心純函式（RED→GREEN）

**Create:** `proxy/src/v104-iteration-shadow-contract.js`
**Test:** `proxy/test/v104-iteration-shadow-contract.test.js`

1. RED：精確7 head、正式權重／門檻複製、無新增key。
2. RED：主強制單邊、副項獨立門檻（雙龍寶／超六不看主方向）。
3. RED：主／副信心到整數單位邊界。
4. RED：MT各項hit/miss/PUSH與龍寶級距淨單位。
5. GREEN：最小純函式實作；無I/O。

## Task 2：不可變發行與Final結算Runtime（RED→GREEN）

**Create:** `proxy/src/v104-iteration-shadow-runtime.js`
**Modify:** `proxy/src/server.js`
**Test:** `proxy/test/v104-iteration-shadow-runtime.test.js`, `proxy/test/v104-iteration-shadow-server.test.js`

1. 事前發行使用正式v104預測輸入，但轉為Shadow flags；同identity first-write-wins、衝突fail closed。
2. Final只接受權威summary/show_win；exact show_poker不結算。
3. 重啟可從DB hydration找pending issuance。
4. 每桌發行序列化；timeout必須傳到底層fetch AbortSignal。
5. Shadow錯誤只記shadow status，不阻塞正式Final、Push ACK或正式health。
6. Feature flag預設false；DB setting disabled時fail closed。

## Task 3：Supabase additive資料面（RED→GREEN＋真DB外層rollback演練）

**Create:**
- `frontend/supabase/schema_v104_iteration_shadow.sql`
- `frontend/supabase/disable_v104_iteration_shadow.sql`
- `frontend/supabase/rollback_v104_iteration_shadow.sql`
**Modify:** `proxy/src/supabase-writer.js`
**Test:** `proxy/test/v104-iteration-shadow-sql.test.js`, `proxy/test/v104-iteration-shadow-writer.test.js`

Tables：settings、model_versions、issuances、settlements、cycle_reports、weight_suggestions。
RPC：issue、settle、history、admin status/report/suggestion reads。
ACL：anon/authenticated/PUBLIC無權；service role只SELECT＋受控RPC EXECUTE，禁止直接DML。Active必須唯一v104。Migration可重跑；disable保留歷史；rollback只撤本功能且不刪歷史。

## Task 4：千局聚合與只調比例建議（RED→GREEN）

**Create:**
- `proxy/src/v104-iteration-shadow-report.js`
- `proxy/src/v104-iteration-shadow-suggester.js`
**Test:**
- `proxy/test/v104-iteration-shadow-report.test.js`
- `proxy/test/v104-iteration-shadow-suggester.test.js`

1. 每1,000 settled rounds建立不重疊cycle report。
2. 主命中分母排除PUSH；副項出手率以1,000局為分母；每head保存actions/hits/misses/pushes、固定與加權淨單位。
3. 主每1,000次、各副項每1,000 actions觸發建議。
4. 候選只能使用凍結key集合，5%格點完整搜尋，權重合計1；門檻／信心／特徵不變。
5. 報告同列baseline與候選；不自動套用。

## Task 5：整張繁中圖表圖片（RED→GREEN）

**Create:** `proxy/src/v104-iteration-shadow-svg.js`
**Test:** `proxy/test/v104-iteration-shadow-svg.test.js`

純SVG、手機直式，含標題／版本／1,000局範圍、主副總覽、7項出手率／命中率／固定及加權正負單位、迭代進度、目前與建議權重。所有動態文字XML escape；無raw payload／帳號／secret。

## Task 6：後台唯讀報表＋人工審核API與UI（RED→GREEN）

**Modify:**
- `proxy/src/server.js`
- `frontend/src/lib/onlineCoreClient.ts`
- `frontend/src/App.tsx`
- `frontend/src/App.css`
**Test:**
- `proxy/test/v104-iteration-shadow-admin.test.js`
- `frontend/src/lib/onlineCoreClient.test.ts`
- `frontend/src/App.test.tsx`

Endpoints僅有效超管session可用：status、reports、suggestions、SVG為唯讀；suggestion review可人工批准／拒絕，但只更新稽核狀態、固定`auto_apply=false`，停用或Rollback後不得再審。後台原頁同構，新增「影子預測迭代」區，不重排既有功能；顯示7項進度、報告圖片及待審核建議。會員API／前台不得出現shadow字段。

## Task 7：版本、完整驗證與發布

- Package release：`1.0.13`；Git tag候選`v104.1.0-seven-head-shadow.1`；正式策略／build/protocol仍維持v104/104。
- Proxy完整測試、Frontend完整測試＋build、Worker完整測試。
- 真DB外層transaction：migration兩次、ACL、duplicate/conflict、Final/PUSH、disable、rollback後ROLLBACK。
- 負向測試：所有影子GET/POST永不resolve fetch均Abort；正式Queue／ACK仍完成。
- 獨立review完整diff。
- 部署順序：DB additive schema → Render exact commit＋flag → 前端Pages；Worker protocol/code未變則不重建。
- Production E2E：唯一Active v104、10桌、正式Final前進、Queue/ACK不退化、影子事前issuance＋Final settlement、正式污染0、後台圖表可見、會員前台無shadow。
