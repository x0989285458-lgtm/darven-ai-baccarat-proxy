# v092 抓牌與寫入穩定性強化

## 範圍
- 不調整預測規則、權重、門檻與既有 UI 版面。
- 不部署、不 push；只完成本機程式與測試。

## 內容
1. 抓牌來源穩定：Worker snapshot 保留「目前頁面/最新局」優先邏輯，並在頁面啟動或 snapshot evaluate timeout 時清空暫存 payload、關閉頁面，下次請求重新建立，避免舊狀態沿用。
2. 真牌資料保留：MT 完成局 rawResult 陣列持續寫入 daily_roadmap_events 的 compact raw_event.rawResult，並保留牌碼、rank、face、點數欄位；對子用 rank 判斷，不用 0 點誤判 J/Q/K/10。
3. 去重：後端 Supabase writer 對同 source/table/shoe/round/strategy 與同實際局 rawResult 做 in-process 去重；SQL 補唯一索引防止 DB 端重複入庫。
4. Worker 復原：proxy 呼叫 cloud worker snapshot 時加入 transient error retry；worker 本身遇 timeout/例外會清 payload、關 page，不回傳 stale tables。
5. 寫入佇列：Supabase REST 寫入序列化，並對 timeout/abort/429/5xx 等短暫失敗重試，降低併發或瞬斷造成資料遺失。

## 新增/更新測試
- proxy/test/v091-db-compact.test.js：v092 真牌/對子判斷、Supabase 寫入佇列/重試/去重。
- proxy/test/cloud-capture-v040.test.js：v092 worker snapshot transient failure retry 與 fresh table 覆蓋 stale state。
- cloud-browser-worker 既有 stale-payload/snapshot 測試確認目前頁面高局數/新靴優先。

## Supabase SQL
- frontend/supabase/schema_v092_stability.sql：daily_roadmap_events、daily_prediction_results、cloud_table_rounds 唯一索引。
