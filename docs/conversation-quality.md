# 對話品質控制

一般微信對話、Chatflow 與網頁試聊共用 RULE-002 的品質規劃。它是生成約束與校準工具，
不是「整批隨機不回」開關；直接問題、明確請求、重要決定及明顯情緒永遠具有回覆義務。

## 有效值與優先級

正式微信對話逐欄合併：**全域 → 人設 → 聯絡人**，越右越優先，沒填的欄位向左繼承。
網頁試聊沒有 Bot/聯絡人身分，只合併 **全域 → 人設**，不會查找或虛構聯絡人覆蓋。

預設值：覆蓋率 70%、追問 20%、短／普通／長 60／30／10、情緒延續 4 個完成輪次、
重複檢查最近 12 個 assistant 輪次。可見字數區間為短 1–20、普通 21–60、長 61–160。
同一 turn 的追問與長度由穩定鍵決定，重試不會重新抽選。

Chatflow 每個 LLM 節點都會在其 system prompt 後附加有效品質區塊。即使流程作者寫了完全
自訂的 system、沒有引用 `{{system_prompt}}`，品質區塊仍會存在。非 LLM 節點不做生成，
不需要注入。

## 可觀測性與隱私

`message.out`、`llm.usage` 與 `worker.job` activity 提供 `conversationQuality` 有效數值設定，
以及 `qualityReasonCodes`（例如 `protected-obligation`、`coverage-limited`、
`follow-up-not-selected`、`length-normal`）。這些欄位不含消息正文、prompt、stable turn key、
topic ID、模型憑證或其他 secret。

## 離線校準

`evaluateConversationQualityFixture()` 接受固定 fixture，輸出回覆義務覆蓋率、是否追問、
可見長度及 bucket、情緒是否延續、近期套話是否重複。零個可見字元（空白或只有表情 token）
使用 `empty` bucket；1–20 字才是 `short`。問句判斷與 runtime 共用同一規則，URL query 的
`?` 不算追問。它不呼叫模型、不讀真實時間，適合把
盲測樣本轉成可重跑的校準資料。固定種子分布測試另會檢查追問及短／普通／長權重。

建議流程：匿名化真機對話 → 標記話題/情緒/回覆 → 跑離線 evaluator → 比較各人設報告 →
在後台調整全域值，或在人設/聯絡人只覆蓋有差異的欄位 → 重跑同一批 fixtures。不要用少量
樣本直接推斷分布，也不要把 evaluator 分數當作內容正確性或安全審核。

## 限制

- 情緒連續性需要 fixture 提供標記；系統不以關鍵字猜測真實情緒。
- 重複檢查只針對近期 assistant 可見文字，不是語意抄襲偵測。
- 長度按整份可見回覆計算；表情 token 與空白不計。
- P2P、系統提示、廣播、限流與主動聯絡不套用本規則。
- 瀏覽器點擊驗收須在合併後串行執行；本文件不代表已完成真機或瀏覽器驗收。
