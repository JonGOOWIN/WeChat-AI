# Issue #11 Playwright 驗收報告

日期：2026-08-15
環境：`http://127.0.0.1:8794`、本地 Redis、本地固定回覆假模型、`WORKER_ENABLED=false`

本輪使用 Microsoft Playwright MCP 真實點擊。沒有控制微信、沒有對外發送、沒有呼叫 live model，
也沒有使用 production secret。

## 結果

| 路徑 | 驗收結果 | 可見證據 |
|---|---|---|
| 全域設定 | 非法 55/25/15/6 回傳 400 且不落庫；合法值保存、重載後一致，最後恢復預設 | [非法值](invalid-global-settings.png) |
| 聯絡人覆蓋 | 空值逐欄繼承；61/31、50/35/15、6、9 保存後重載一致；清除後回到繼承 | [保存值](peer-override-persisted.png) |
| 人設覆蓋 | 65/25、50/35/15、5、10 保存後重載一致 | [保存值](persona-override-persisted.png) |
| Prompt 試聊 | 本地假模型成功回覆；活動只採全域→人設 | [試聊](prompt-try-chat.png)、[活動](prompt-quality-activity.png) |
| Chatflow 試聊 | 自訂 LLM system 不含 `{{system_prompt}}` 仍成功；活動含有效品質資料 | [流程](chatflow-custom-system.png)、[活動](chatflow-quality-activity.png) |

## Runtime activity

Prompt：

- `personaMode=prompt`
- `conversationQuality={coveragePercent:65, followUpPercent:25, lengthWeights:[50,35,15], emotionContinuityTurns:5, repetitionWindowAssistantTurns:10}`
- `qualityReasonCodes=[protected-obligation, coverage-complete, follow-up-not-selected, length-short]`
- `promptTokens=10, completionTokens=5, totalTokens=15`

Chatflow：

- `personaMode=chatflow`
- `conversationQuality={coveragePercent:70, followUpPercent:20, lengthWeights:[60,30,10], emotionContinuityTurns:4, repetitionWindowAssistantTurns:12}`
- `qualityReasonCodes=[coverage-complete, follow-up-selected, length-short]`
- `promptTokens=10, completionTokens=5, totalTokens=15`

兩筆活動均未出現使用者／assistant 正文、試聊 session ID、stable turn key、covered／omitted／
protected topic IDs、API key 或模型 secret。

## 自動化閘門

- `npm run lint`：通過
- `npm run typecheck`：通過
- `npm test`：通過（API 224 項，新增的 try-chat activity 2 項均通過）
- `npm run build`：通過
