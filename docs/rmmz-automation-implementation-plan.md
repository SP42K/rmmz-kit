# RPG Maker MZ 自動化工具鏈 — Implementation Plan

版本 0.2 ・ 2026-08-12（0.1 的目標是「補充編輯器」；0.2 修訂為「最大程度取代編輯器」，見 §0）

> 進度現況見 `CLAUDE.md`（single source of truth），本文件不重複維護 status。

---

## 0. 範圍與命名對齊

先把兩套編號對齊，避免混淆：

- **L0–L6，另有 L3.5、L4.5 兩個半層（共九層）** 是**架構分層**（software layers），是你要蓋的東西。
- **Lv1–Lv10** 是**自動化等級**（capability levels），是你想達成的目標。

兩者的關係不是一對一，而是「幾個層一起解鎖一個等級」：

| 層 | 內容 | 解鎖的 Lv |
|---|---|---|
| **L0** 專案 I/O | 原子寫入、transaction、editor lock、git | 前置，不直接解鎖 |
| **L1** 資料模型 | 型別、ID 配置器、全域參照索引 | 前置 |
| **L2** 事件編譯器 | DSL/IR → event command 陣列 | **Lv1, Lv2** |
| **L3** 語意化 API | MCP 工具層 | Lv3（DB 部分） |
| **L3.5** 地圖合成 | 模板拼接 + autotile + 連通性 | **Lv4** |
| **L4** 驗證器 | schema / 參照完整性 / 圖分析 | **Lv5, Lv7（靜態）** |
| **L4.5** 戰鬥模擬器 | 純 Node 跑傷害公式 | **Lv3（平衡）** |
| **L5** 執行期 | headless 遊戲 + 測試插件 + 斷言 | **Lv6, Lv7（動態）** |
| **L6** Agent loop | plan → generate → validate → test → repair | **Lv8, Lv9** |
| — | — | Lv10 不在本計畫範圍，見 §7 |

### Lv1–Lv9 定義

| Lv | 代表能力 | 大致驗收方式 |
|---|---|---|
| **Lv1** | 用 DSL 寫出單一事件並編譯成合法 command 陣列 | M3 round-trip 測試 |
| **Lv2** | 讀懂既有事件（decompile 成 DSL 給 LLM 看） | M3 decompile 測試 |
| **Lv3（結構）** | 透過 MCP 工具新增/修改資料庫列與地圖事件 | M5 acceptance（見下） |
| **Lv3（平衡）** | 新增的戰鬥/數值改動不會明顯破壞平衡 | M6 模擬勝率誤差 < 10% |
| **Lv4** | 生成連通、事件可達的地圖 | M7 acceptance |
| **Lv5** | 靜態驗證擋下常見錯誤（懸空參照、結構錯誤） | M4 acceptance |
| **Lv6** | headless 跑起遊戲並做狀態斷言 | M8 acceptance |
| **Lv7（靜態/動態）** | 靜態規則 + 動態測試合起來覆蓋語意錯誤 | M4 + M8 acceptance 合併判定 |
| **Lv8** | 自動修復 agent 能在靜態/動態錯誤回饋下重生成並收斂 | M9 acceptance |
| **Lv9** | 一句話生成可完整通關的小型 RPG | M10 acceptance |

Lv10 見 §7。

### 目標（0.2 修訂）

v0.1 把「取代 MZ 編輯器」列為非目標（工具鏈是補充，人在編輯器裡潤飾）。0.2 起翻轉：
**agent 經 MCP 最大程度取代編輯器** — 人只下需求，agent 經 L3 工具層完成資料庫、地圖、
事件、插件、素材、測試遊玩與部署的全部編輯，人只在下方非目標處介入。缺口與排程見
「編輯器對等能力對照表」與 §3。

### 非目標（明確排除）

- 生成 Effekseer 動畫（`.efkefc` 二進位，不可行，一律重用內建 120 個）
- 生成美術與音樂素材、角色產生器（授權與風格一致性問題，見 §7）
- 支援 RPG Maker MV（資料格式相近但插件指令格式不同，會拖慢 L2）
- 人用 GUI / 視覺化編輯介面（取代形態是 agent 經 MCP，不是給人另做一個編輯器）

### 編輯器對等能力對照表

「取代編輯器」的對齊軸，與 Lv1–Lv9（自動化等級）並列、不互相取代。

| 編輯器功能 | 對應層 / 工具 | 現況 | 排入 |
|---|---|---|---|
| 資料庫：flat 表（Actors…Troops、CommonEvents） | `upsert_database`（10 表） | ✓ | M5 已交付 |
| 資料庫：System（標題/初始隊伍/用語/戰鬥系統） | `update_system`（object merge，非列模型） | ✗ | M6.5 |
| 資料庫：Tilesets / Animations / MapInfos | `upsert_database` 加表 | ✗ | M6.5 |
| 地圖生命週期（新建/刪除/改尺寸、地圖樹） | L0 create-file + `create_map`/`resize_map` | ✗（L0 不能新建檔案） | M7 |
| 地圖繪製（tile / autotile / 通行度） | `paint_tiles` 原語 + L3.5 拼接 | ✗ | M7 |
| 事件：Tier 1 命令 | `apply_script`（L2 編譯器） | ✓ | M3/M5 已交付 |
| 事件：Tier 2（357 插件指令、商店、戰鬥、移動路線…） | L2 Tier 2 + `PageSpec.moveRoute` | ✗ | M7.5 |
| 插件管理（js/plugins.js） | `manage_plugins` | ✗ | M7.6 |
| 素材：清單 | `rmmz://asset-catalog` | ✓ | M5 已交付 |
| 素材：匯入 | `import_asset` | ✗ | M7.6 |
| 測試遊玩（起遊戲給人玩） | `playtest`（http server + 瀏覽器） | ✗ | M8 前段 |
| headless 測試 / 斷言 | M8 harness | ✗ | M8 |
| 部署匯出（web / Windows、未用素材剔除） | `deploy` | ✗ | M11 |
| 新建專案 | `create_project`（fixture 為模板） | ✗ | M11 |

---

## 1. 架構總覽

### 1.1 兩個核心設計決策

**決策 A：core library + thin MCP wrapper，不要寫成純 MCP server**

價值 90% 在編譯器與驗證器，MCP 只是傳輸層。做成獨立 npm library（`rmmz-kit`）＋ CLI，MCP server 只是薄薄一層 adapter。好處：

- CI 可以直接跑（不需要 agent）
- 可以寫單元測試（純函式，不用起 MCP）
- 未來換 agent 介面（skill / SDK / 別的 protocol）不用重寫

**決策 B：transaction 模型，不要 per-call 讀寫檔案**

兩個參考專案都是「每個 tool call 讀整個 JSON → 改 → 寫回」。這造成三個問題：I/O 放大（畫一格 tile 寫一次全圖）、無原子性（中途失敗檔案毀損）、無跨檔一致性（改了 switch 名稱但引用它的事件沒同步）。

改成：

```
openProject(path)
  ├─ 讀入所有 data/*.json 到記憶體（ProjectSession）
  ├─ 取得 editor lock（偵測 MZ 編輯器是否開啟）
  └─ 建立參照索引（誰用了 switch 7、誰引用 Map012）

  ...N 次操作全在記憶體，零磁碟 I/O...

validate()            → 不過就整批丟棄，不落地
commit(message)       → 原子 flush（tmp + rename）+ git commit
```

**「驗證不過就不落地」**是這個模型最重要的性質：專案永遠處於合法狀態，agent 的失敗嘗試不會污染 repo。

### 1.2 目錄結構

```
rmmz-kit/
├─ packages/
│  ├─ core/                    L0+L1
│  │  ├─ session.ts            ProjectSession（transaction）
│  │  ├─ io.ts                 原子寫入、compact JSON、editor lock
│  │  ├─ types/                MZ 資料結構型別
│  │  ├─ idAllocator.ts        switch/variable/事件 ID 配置
│  │  └─ refIndex.ts           全域參照索引
│  ├─ compiler/                L2
│  │  ├─ dsl/                  語法 + parser
│  │  ├─ ir.ts                 中間表示
│  │  ├─ emit.ts               IR → event command
│  │  └─ commands/             各 command code 的 emitter
│  ├─ mapgen/                  L3.5
│  │  ├─ autotile.ts           shape bits 計算
│  │  ├─ prefabs/              手作房間模板
│  │  └─ compose.ts            拼接 + 連通性
│  ├─ validate/                L4
│  │  ├─ rules/                每條 lint rule 一個檔
│  │  └─ graph.ts              quest graph 可達性
│  ├─ battlesim/               L4.5
│  ├─ runtime/                 L5
│  │  ├─ harness.ts            headless 啟動
│  │  ├─ plugin/AutoTest.js    注入遊戲的測試插件
│  │  └─ assert.ts
│  ├─ agent/                   L6
│  ├─ cli/
│  └─ mcp/                     L3（薄 adapter）
└─ fixtures/
   └─ minimal-project/         最小 MZ 專案，測試用
```

---

## 2. 參考專案可用部分盤點

我把兩個 repo clone 下來實讀過。以下是逐檔判定。

> M0–M5 已完成遷移，本節為當時（規劃階段）的盤點紀錄，非目前待辦清單。少數項目
> 判定為「直接搬」但實際實作時改走別的路線，已在對應列註明。

### 2.1 `k4zuki0539/-rpgmaker-mz-mcp`（2,098 LOC，無測試）

| 檔案 | 判定 | 說明 |
|---|---|---|
| `src/utils/types.ts` (319行) | ✅ **直接搬** | MZ 資料結構的 TypeScript 型別定義。整個 repo 最有價值的部分，省你 3-5 天查資料。搬過來後要補 Enemy / Troop / Class / State / CommonEvent。 |
| `mapTools.ts` 的 tile 索引公式 | ✅ **直接用** | `index = (layer * height + y) * width + x` — 這個是對的，MZ 的 6 層一維陣列就是這樣排。 |
| `skillTools.ts` 的 `createDamageSkill` / `createHealingSkill` / `createBuffSkill` / `createStateSkill` | 🔶 **當語意參考** | 不要抄程式碼，但這幾個函式把 MZ 的 `damage.type` / `damage.formula` / `effects[]` 欄位對應整理過了，抄那個對應關係。 |
| `index.ts` 的 35 個工具 schema | 🔶 **當 checklist** | 拿來核對「哪些資料表要支援」，**不要照抄顆粒度**（見 §4.5）。 |
| `src/utils/fileHandler.ts` | ❌ **不要用** | `JSON.stringify(data, null, 2)` 會讓地圖檔膨脹數倍；無原子寫入；無備份；`game.rmmzproject` 小寫在 case-sensitive FS 上認不出專案。 |

### 2.2 `rein1225/RPGMakerMZ_MCP`（4,672 LOC，有單元測試 + GitHub Actions）

工程品質明顯高一截，可搬的東西多。

| 檔案 | 判定 | 說明 |
|---|---|---|
| `resources/event_commands.json` (295行) | ⛔ **未採用** | 原判定「直接搬」，實作時改為把 command code 直接硬編在 `packages/compiler/src/ir.ts`/`emit.ts`，沒有用這份 JSON 字典。 |
| `utils/constants.js` 的 `EVENT_CODES` | ⛔ **未採用** | 同上，code 常數直接寫在 `ir.ts`/`emit.ts` 裡。 |
| `handlers/plugins.ts` (133行) | ⛔ **未採用** | `js/plugins.js` 解析目前沒有任何套件讀取；fixture 雖含此檔，但沒有對應功能。留待有需求時再做。 |
| `utils/commandAnnotator.js` | ⛔ **未採用** | 沒有搬；`packages/compiler`的 decompiler（`decompile.ts`）取代了「讓 LLM 讀懂現有事件」這個用途。 |
| `utils/logger.js` / `utils/errors.js` | ✅ **直接搬** | 結構化錯誤與日誌，寫得規矩，省時間。 |
| `utils/mapHelpers.ts` | 🔶 **改寫後用** | `getEventPageList` 的邏輯可用；`loadMapData`/`saveMapData` 要換成 session 版本。 |
| `test_project/` | ✅ **直接搬** | 現成的最小 MZ 專案 fixture（含 `game.rmmzproject`、`index.html`、`data/*.json`、`js/plugins.js`）。省你手動造測試資料，**第一天就用得上**。 |
| `.github/workflows/test.yml` | ✅ **直接搬** | CI 骨架。 |
| `utils/backup.ts` + `handlers/undo.ts` (336行) | 🔶 **概念可用，實作要換** | `withBackup(filePath, op)` 的 wrapper 模式很好。但它把 `.{timestamp}.bak` 直接寫進 `data/`，會污染專案目錄。**建議換成 git**：commit 即備份，undo 即 `git revert`，還免費得到歷史與 diff。 |
| `handlers/playtest.ts` (356行) 的 **http server 部分** | ✅ **搬這一半** | `http.createServer` + `serve-handler` 起本地站台餵 `index.html` 給瀏覽器，這段 scaffolding 直接可用。 |
| `handlers/playtest.ts` 的 **Game.exe + `screenshot-desktop`** 分支 | ❌ **不要用** | 抓原生視窗截圖，Windows-only 且極脆。統一走瀏覽器路線。 |
| `automation/lib/mz_driver.js` (105行) | ❌ **只當反面教材** | `page.keyboard.press('ArrowUp')` + `setTimeout(200)` 模擬移動、靠文字比對點 UI（註解自己寫 "This is a heuristic"）。沒有加速、沒有決定性、沒有狀態斷言。這正是 §4.6 要換掉的路線。 |
| `utils/gameStateInspector.ts` | ⚠️ **分兩種用途，M5 未採用** | 白名單只允許 `$gameSwitches.value(n)` 這類讀取。**production MCP 保留這個白名單**（安全），但**測試 harness 不能用**——測試需要 dump 完整狀態，白名單會擋死。兩條路徑要分開。**現況**：`packages/mcp` 沒有這層白名單，M5 已 merge；見 §6 R8。 |
| `schemas/mz_structures.js` (80行) | 🔶 **參考** | 內容比 k4zuki 的 types.ts 薄。 |

### 2.3 盤點結論

**可直接複用約 1,200–1,500 行**，主要集中在 L0 的周邊（logger / errors / plugins.js 解析 / fixture / CI）與 L2 的字典種子。

**兩個 repo 都完全沒有的**（也就是你的真正工作量所在）：

1. L2 事件編譯器 — 兩邊都是讓呼叫端直接餵 `{code, indent, parameters}`
2. L4 驗證器 — 兩邊都是 shallow merge 什麼都收
3. L4.5 戰鬥模擬器 — 完全沒有這個概念
4. L5 的決定性測試 harness — rein 有雛形但走錯路線
5. L6 repair loop — 兩邊都沒有

---

## 3. Milestone 計畫

工時以**單人全職**估算。標 ⭐ 的是關鍵路徑。

### M0 — 骨架與 fixture ・ 0.5 週

- monorepo 骨架、tsconfig、vitest、CI
- 搬入 `rein/test_project/` 當 fixture，搬 `logger.js` / `errors.js`
- 建立「MZ 格式假設」的單一集中檔（見 §6 風險 R1）

**驗收**：`npm test` 綠燈，能讀出 fixture 的 System.json。

---

### M1 ⭐ — L0 專案 I/O 與 transaction ・ 1.5 週

- `ProjectSession`：open / mutate / validate / commit / rollback
- **原子寫入**：寫 tmp file → `fs.rename`（同一 filesystem 才有原子性，注意）
- **compact JSON 輸出**：比對 MZ 編輯器實際輸出格式，逐檔對齊（`data` 陣列不換行）
- **editor lock**：偵測 MZ 編輯器是否持有專案；偵測不到就至少警告
- **git 整合**：commit 即備份，取代 `.bak`
- 專案根偵測要 case-insensitive 找 `Game.rmmzproject`

**驗收**：對 fixture 做 100 次修改 + commit，`git diff` 只顯示語意上改動的行；殺掉 process 在寫入中途，專案不毀。

**風險**：MZ 的精確 JSON 格式沒有官方 spec，只能對照實際輸出逆向。留一組 golden file 測試。

---

### M2 ⭐ — L1 資料模型 ・ 1.5 週

- 搬 k4zuki 的 `types.ts`，補齊 Enemy / Troop / Class / State / CommonEvent / Tileset
- **ID 配置器**：switch / variable / commonEvent / actor… 的 ID 申請與釋放，含「命名空間」概念（讓 quest A 的旗標集中在 100-199）
- **參照索引**：反向索引「switch 7 被哪些事件引用」「Map012 被哪些傳送點指向」。這是 L4 的地基，也是 rename/refactor 的地基。

**驗收**：對 fixture 建索引，能正確回答「刪掉 item 3 會影響哪些地方」。

---

### M3 ⭐⭐ — L2 事件編譯器 ・ 4 週（可分批）

**這是全案的技術核心。**

- 擴充 `event_commands.json` 到 Tier 1 + Tier 2（§4.3）
- 定義 DSL（§4.2）+ parser
- IR → command 陣列 emitter，**由編譯器負責 indent 計算與分支收尾**
- 反向 decompiler（command 陣列 → DSL），用於讀取既有事件給 LLM 看

**分批策略**：Tier 1（約 15 個 code）先做，涵蓋 80% 用途，1.5 週可上線；Tier 2 再 2.5 週。

**驗收**：
- Round-trip 測試：`decompile(compile(dsl)) === dsl`
- 對 fixture 既有事件做 `decompile(compile(decompile(x))) === decompile(x)`（idempotent——
  emit 一律寫回完整正典參數陣列，因此不保證對任意既有資料 byte-identical，只保證穩定）
- 隨機生成 1000 份 DSL，編譯結果 100% 通過結構檢查

---

### M4 ⭐ — L4 驗證器 ・ 2.5 週

規則清單見 §4.4。分三類：

- **結構**（編譯器已保證，這裡當防線）
- **參照完整性**（懸空 ID、素材檔不存在）
- **語意/圖分析**（quest 不可達、switch 衝突、self-switch 未重置）

**驗收**：手動在 fixture 埋 20 種已知錯誤，偵測率 ≥ 18/20。

---

### M5 — L3 MCP 工具層 ・ 1 週

薄 adapter。工具顆粒度見 §4.5。~~保留 rein 的 `gameStateInspector` 白名單當安全層~~
——**未實作**，`packages/mcp` 目前沒有這層白名單，見 §6 R8。

**驗收**：Claude Desktop 接上能完成「在 Map001 加一個賣藥水的 NPC」。（已達成，見 §4.5
實際交付清單。）

---

### M6 — L4.5 戰鬥模擬器 ・ 1.5 週

**強烈建議插在 L5 之前做。** 投報率全案最高。

MZ 的傷害公式是 eval 字串（`a.atk * 4 - b.def * 2`），可以在 Node 的沙箱裡直接跑，**不需要開遊戲**。

- 實作 `Game_Battler` 的最小子集：八圍、狀態、元素抗性、命中/迴避/會心
- 依 MZ 的 `Game_Action.prototype.makeDamageValue` 複製傷害計算（含 variance、guard、critical）
- 跑 N=1000 場，輸出：勝率、平均回合數、TTK、傷害分佈、是否有一擊必殺/無限僵持

**驗收**：對 MZ 內建範例的幾組敵我配置，模擬勝率與實際遊戲測試誤差 < 10%。

**價值**：用 ~10% 的 L5 成本，拿到動態驗證價值的一大半，把 Lv3 的「平衡合理度」從 55% 拉到 85%。

---

### M6.5 — 資料庫完備 ・ 0.5 週

編輯器對等（§0 對照表）最便宜的一格，無前置依賴：

- `packages/mcp/src/tables.ts` 加 `tilesets` / `animations` / `mapInfos`（三者都是 flat
  array，`upsert_database` 直接吃）
- 新 `update_system` 工具：System.json 是單一 object 不是 array，`upsert_database` 的
  列模型不適用，做 shallow merge（巢狀欄位如 `terms` 整塊替換）

**驗收**：經 MCP 改遊戲標題、用語、tileset 通行 flag，編輯器開啟無損。

**已知缺口（實作後 code review 找出，刻意不在 M6.5 修）**：三項都是「`upsert_database`
的通用列模型套在有額外不變量的表上」的同一個病灶，只是代價各異。已修的一項（MapInfos
新增列會產生沒有 `Map###.json` 的幽靈地圖，而 `references/dangling-map` 又以 MapInfos
為「地圖存在」的判準，於是 transfer 到幽靈地圖零 finding）已在本里程碑擋掉——改成只能編輯
既有地圖，建檔是 `compose_map`（M7）的事。剩餘三項：

| # | 缺口 | 代價 | 排程 |
|---|---|---|---|
| 1 | ~~`tilesets` 新增列只寫 `{name, id}`，沒有 8192 長度的 `flags`；MZ `Game_Map.checkPassage` 讀 `this.tileset().flags[tileId]`，玩家踏第一步就爆~~ | 中 | **M7 已修**：`tables.ts` 的 `NEW_ROW_DEFAULTS` 只在「這個 id 還沒有列」時補上 `flags` / `tilesetNames` / `mode`，不碰既有列。清單刻意保持接近空的——per-table schema 仍是 §4.5 說不要提前做的建模，要進這張表得先講得出它擋掉哪一種 crash |
| 2 | `update_system` 的 `patch.switches` / `patch.variables` 整塊替換陣列，而這兩個名稱陣列是 `IdAllocator.findContiguousFree` 判斷「已佔用」的唯一依據（free = 未命名）。被覆寫後已配發的 id 看起來是空的，下一次 `allocate_namespace` 會發出事件正在寫的 switch | 中 | **M7.5 或 `allocate_namespace` 下次動到時**。修法不是在 `update_system` 加特例，而是讓 allocator 有自己的佔用紀錄（namespace 表），這也是 §4.2 具名 switch/variable sugar 遲早要做的事 |
| 3 | ~~`upsertDatabase` 就地 mutate `data`：第 2 筆的 id 檢查 throw 時，第 1 筆已經寫進去了，而 `updateFile` 還沒把檔案標成 dirty——於是 `diff` 看不到它、`rollback()`（只重讀 dirty 檔）也救不回來，下一次不相干的編輯會把這半套改動一起 commit。**此為 M6.5 之前就有的既存問題**，非本次引入~~ | 中 | **已於 M7 修掉**：`updateFile` 改成先 `dirty.add()` 再跑 updater。這比當初設想的「複製 `[...data]` 再寫回」小得多，也不動 `allocEntityId` 讀 session 即時陣列的行為；代價只是 updater 尚未 mutate 就 throw 時多寫一次位元組相同的檔案 |

---

### M7 — 地圖 ・ 4 週

原「L3.5 地圖合成」擴為編輯器對等的完整地圖能力，分兩半：

**前半：編輯原語（0.2 新增範圍）**

- **L0 create-file**：`ProjectSession` 支援新增檔案（created 集合；rollback 丟棄、commit
  寫入、lock snapshot 納入）— 新建地圖的前置，目前 `updateFile` 對不存在的檔案 throw
- `create_map` / `resize_map`：含 MapInfos 地圖樹維護
- `paint_tiles` 原語：`index = (layer * height + y) * width + x`（§2.1）+
  **autotile shape bits 計算**（tileId ≥ 2048 那組）— 這是確定性演算法，做對就是 100%
- 通行度 / 地形標籤設定（Tilesets flags，配 M6.5 的表支援）

**後半：合成（原 M7 範圍）**

- 手作 20–30 個 prefab（房間、走廊、店舖、洞窟段、城鎮區塊）
- 拼接器：BSP 或圖驅動，加通行度檢查與**連通性驗證**（保證每個事件都走得到）
- 裝飾規則（靠牆放家具、門口留空）

**務實提醒**：不要讓 LLM 逐格畫圖。LLM 負責「這張地圖要有哪些房間、什麼氛圍、事件放哪」，程式負責畫；`paint_tiles` 是程式的原語，不是 LLM 的介面。

**驗收**：新建一張地圖、畫房間、設通行度，編輯器開啟顯示正確（autotile 接縫正確，見 §6
R9）；生成 20 張地圖，100% 連通且所有事件可達；人工評分「看起來像人做的」≥ 70%。

**實作結果**：`packages/mapgen`（`autotile.ts` / `edit.ts` / `passage.ts` / `compose.ts`）＋
core 的 `ProjectSession.createFile()` ＋ MCP 的 `create_map` / `resize_map` / `paint_tiles` /
`set_tile_flags` / `compose_map`。M6.5 缺口 #1（新增 tileset 列沒有 8192 長 `flags`）順手在此
關掉，改由 `tables.ts` 的 `NEW_ROW_DEFAULTS` 供給。

autotile shape 編號沒有 spec，實作方式是**從 MZ 自己的 `Tilemap.FLOOR_AUTOTILE_TABLE` 反推**
（每個 shape 畫哪四個 1/4 圖塊 → 哪幾邊是邊界），得到「16 種凹角組合 → 一/二/三/四邊開放」
的枚舉規則，由程式生成而非硬寫 47 個魔術數字。有一個坑值得記：單邊開放組的角是**從該邊順
時針往後**繞著數的，所以「右邊開放」那組是先左下再左上——照直覺永遠從左上開始的移植會在這
一組錯位。測試窮舉 256 種鄰居組合，斷言產出恰為 0–46。

**未做（刻意，非遺漏）**：

| 缺口 | 為什麼 | 排程 |
|---|---|---|
| 20–30 個手作 prefab，改用 BSP | prefab 是對著某套 tileset 畫的內容，本 repo 沒有 MZ 素材（`fixtures/minimal-project` 是手寫的），對著猜的 tile id 畫出來的 prefab 價值低於對著呼叫端 tileset 畫的矩形。BSP 另外把「連通」變成建構保證而非修補 pass | 有真實素材專案時再評估 |
| 裝飾規則 ・「看起來像人做的」≥ 70% | 同上，要有真 tileset 的 B–E 圖塊可放；且這是評分不是演算法 | 同上 |
| validator 的「所有事件可達」規則 | `analyzeReachability()` 已在 `mapgen` 匯出、`compose_map` 也用它斷言，但套到手作地圖上會對正常東西發警告（停在 0,0 的並列處理事件、放在不可通行格上的裝飾事件），會叫的 validator 沒人理 | 有真實專案的誤報率數據再說 |
| autotile 越界鄰居的處理 | 目前 clamp（視為邊緣格延伸，所以畫到地圖邊緣不生接縫），這是 R1/R9 級假設，全部集中在 `tileAt` 的一個 clamp | 對照編輯器實際輸出後一行可改 |

**已知缺口（實作後 code review 找出，刻意不在 M7 修）**：五項 finding 中三項已在本里程碑修掉
（`paintMapData` 改成全部 op 驗完再畫；`updateFile` 改成先標 dirty 再跑 updater——這順帶關掉
上面 M6.5 缺口 #3，且避開了那條註記說會壞掉 `allocEntityId` 的「複製再寫回」修法；
`analyzeReachability` 的「無區域」哨兵改用 `NaN`，原本的 `-1` 與未走訪格同值，整張地圖不可進入
時反而回報所有事件都可達）。剩兩項：

| # | 缺口 | 代價 | 排程 |
|---|---|---|---|
| 1 | `composeMap` 的連通性 throw 發生在 `createMap` 已寫入 `Map###.json` ＋ MapInfos 列、`ensureFlags` 已改掉 97 筆 tileset flag *之後*；這些改動留在 session 裡，呼叫端若沒整批 rollback 就會 commit 出一張不連通的地圖。觸發路徑：`setFlags: false` 配上一套沒把地板設成可通行的 tileset | 低（要非預設參數才踩得到；且 throw 本身有講清楚） | 需要把 `analyzeReachability` 改成能吃脫離 session 的 `MapData`（現在它從 session 讀 map 與 tileset），才能在建檔前先驗。等哪天有第二個呼叫端需要「先驗再落地」時一起做 |
| 2 | `resizeMap` 事後重算 shape 是掃**整張**地圖的 layer 0–1，不是只掃放大後新暴露的邊帶：會蓋掉呼叫端刻意用 `autotile: false` 寫的 tile，也會在本模組 R9 推導與 MZ 實際輸出不一致處重畫編輯器做的地圖 | 低 | 目前這個全圖 pass 是刻意的（縮小也可能讓內部格變成邊緣格）。等上面 autotile clamp 那條對照過真實編輯器輸出、確認推導無誤後，再決定要不要縮成邊帶 |

---

### M7.5 — L2 事件編譯器 Tier 2 ・ 2.5 週

§4.3 Tier 2 清單照做，**357 插件指令優先**（真實專案幾乎必用，也是 M7.6 插件管理的語意
出口）；順手開放 `upsert_map_event` 的 `PageSpec.moveRoute`（目前寫死預設值）。

**驗收**：同 M3 的 round-trip / idempotent 標準，涵蓋 Tier 2 全部 code。

---

### M7.6 — 插件與素材 ・ 1 週

- `manage_plugins`：js/plugins.js 的 parse/write（§2.2 rein `handlers/plugins.ts` 當年
  判定「留待有需求」，需求即此）
- `import_asset`：把檔案複製進 `img/` / `audio/` 的正確子目錄，asset-catalog 即時反映

**驗收**：經 MCP 啟用一個插件、匯入一張角色圖並在事件中引用，validate 綠燈、編輯器開啟無損。

---

### M8 ⭐⭐ — L5 headless 測試框架 ・ 8 週

**全案最大宗、風險最集中。** 建議在 M6 完成、確認整條鏈有價值之後再投入。

**前段交付（第 1 週內）：`playtest` 工具** — 搬 rein `handlers/playtest.ts` 的 http server
半邊（§2.2 判定 ✅ 搬這一半），起本地站台開瀏覽器讓人試玩。這是編輯器 playtest 按鈕的
對等品（§0 對照表），不等 harness 完工就先交付。

已知的坑（逐項都要解）：

| 坑 | 對策 |
|---|---|
| PIXI + WebGL 在 headless 起不來 | `--use-gl=swiftshader`，或強制 canvas renderer |
| WebAudio 卡住載入流程 | 注入 stub 取代 `WebAudio` / `Html5Audio` |
| 60fps 主迴圈太慢 | override `SceneManager.update` 的 tick 驅動，用「邏輯幀推進」取代 rAF |
| TPB 戰鬥非決定性 | 測試時強制 `$dataSystem.battleSystem = 0`（回合制） |
| 亂數非決定性 | override `Math.random` 為 seeded PRNG |
| 存讀檔路徑差異 | 瀏覽器模式走 localStorage，測試前清空 |

**核心產出：`AutoTest.js` 測試插件**（注入遊戲的 API）

```js
// 對外暴露 window.__AT
__AT.teleport(mapId, x, y)
__AT.runEvent(mapId, eventId, page)      // 直接觸發，不用走過去
__AT.setSwitch(id, val) / .setVar(id, val)
__AT.dumpState()                          // 完整狀態快照（非白名單）
__AT.seed(n)                              // 固定亂數
__AT.step(frames)                         // 推進 N 邏輯幀
__AT.waitIdle(maxFrames)                  // 等事件執行完
__AT.captureMessages()                    // 收集本次顯示的所有文字
__AT.coverage()                           // 事件/對話節點覆蓋率
```

測試寫成**狀態斷言**而非截圖比對：

```ts
await at.runEvent(3, 5);
await at.waitIdle();
expect(await at.getSwitch(12)).toBe(true);
expect(await at.partyHasItem(7)).toBe(true);
```

截圖只保留給視覺回歸。

**驗收**：對 fixture 跑完一條 3 事件的任務鏈，全綠，單次執行 < 10 秒。

---

### M9 — L6 Agent repair loop ・ 3 週

```
plan → generate(DSL) → compile → validate
  ├─ 靜態錯誤 → 回饋具體錯誤 → 重生成（上限 3 次）
  └─ 通過 → commit 到暫存分支 → playtest
       ├─ 斷言失敗 → 回饋失敗軌跡 + 狀態 diff → 修復（上限 3 次）
       └─ 通過 → merge
```

**必要配套**（沒有這些 loop 會把專案改爛）：

- **迴歸測試集**：每次修復都跑全套，不是只跑失敗那條
- **振盪偵測**：同一組測試在 A/B 之間來回失敗 → 停止並上報人類
- **修復次數上限** + git 分支隔離 + 失敗即 `git reset`
- **錯誤訊息品質**是修復率的決定變數，投資在這裡比投資在 prompt 上划算

**驗收**：人工植入 20 個 bug（10 靜態 / 10 動態），自動修復率 ≥ 靜態 8/10、動態 4/10。

---

### M10 — Lv9 端到端 ・ 2 週整合

「一句話 → 30-60 分鐘可玩小 RPG」。這階段主要是編排與 prompt 工程，不是新架構。

**驗收**：連續 10 次生成，≥ 6 次可完整通關且不卡關。

---

### M11 — 部署匯出與專案建立 ・ 1 週

- `deploy`：web 打包（複製專案 + 以 RefIndex 剔除未引用素材）；Windows 為 NW.js 殼複製
- `create_project`：從模板（fixture 的擴充版）新建可開啟的空專案

編排上可提前——只依賴 L0/L1，不依賴 M8/M9/M10。排最後是因為對「取代編輯器」而言它是
收尾動作，不是天天用的能力。

**驗收**：對 fixture deploy 出的 web 包可在瀏覽器完整遊玩；`create_project` 產出的專案
編輯器可直接開啟。

---

### 3.1 總表

| Milestone | 工時 | 累計 | 解鎖 |
|---|---|---|---|
| M0 骨架 | 0.5 週 | 0.5 | — |
| M1 L0 I/O | 1.5 週 | 2 | — |
| M2 L1 資料模型 | 1.5 週 | 3.5 | — |
| M3 L2 編譯器 | 4 週 | 7.5 | **Lv1, Lv2** |
| M4 L4 驗證器 | 2.5 週 | 10 | **Lv5, Lv7 靜態** |
| M5 L3 MCP 層 | 1 週 | 11 | **Lv3 結構** |
| M6 戰鬥模擬器 | 1.5 週 | 12.5 | **Lv3 平衡** |
| M6.5 資料庫完備 | 0.5 週 | 13 | 對等：資料庫全表 |
| M7 地圖 | 4 週 | 17 | **Lv4** + 對等：地圖 |
| M7.5 L2 Tier 2 | 2.5 週 | 19.5 | 對等：事件全量 |
| M7.6 插件與素材 | 1 週 | 20.5 | 對等：插件 / 素材匯入 |
| M8 L5 測試框架 | 8 週 | 28.5 | **Lv6, Lv7 動態** + 對等：playtest |
| M9 L6 repair loop | 3 週 | 31.5 | **Lv8** |
| M10 端到端 | 2 週 | 33.5 | **Lv9** |
| M11 部署 | 1 週 | 34.5 | 對等：部署 / 新建專案 |

**三個明確的中止點**（每個都是可交付的完整產品）：

- **M5 結束（11 週）** — Lv1-3 + Lv5 靜態。已經很有用，可以停在這裡。
- **M7.6 結束（20.5 週）** — Lv1-5 全解 + 編輯器對等除 playtest/部署外全格。CP 值最佳點。
- **M9 結束（31.5 週）** — Lv1-8。

---

## 4. 關鍵設計細節

### 4.1 ProjectSession 介面草案

```ts
const s = await openProject('./MyGame', { requireEditorClosed: true });

const quest = s.allocNamespace('quest.herb', { switches: 10, vars: 5 });
const npc = s.map(1).addEvent({ name: '藥草師', x: 12, y: 8 });
npc.page(0).script(dsl);          // ← 進 L2 編譯器

const report = await s.validate();  // L4
if (report.errors.length) { s.rollback(); throw ... }
await s.commit('feat: 藥草任務');   // 原子 flush + git
```

### 4.2 DSL 草案

設計原則：**LLM 寫的東西不該包含任何 indent 或 code number**。

```yaml
event:
  name: 藥草師
  x: 12
  y: 8
  sprite: People1/3
  trigger: action
  pages:
    - when: "!quest.herb.started"
      do:
        - say: { speaker: 藥草師, face: Actor1/2, text: "北邊森林有藥草…能幫我採三株嗎？" }
        - choice:
            "好": 
              - set: quest.herb.started = true
              - say: "太感謝了！"
            "不了":
              - say: "…也罷。"
    - when: "quest.herb.started && !quest.herb.done"
      do:
        - if: "party.has(item.herb, 3)"
          then:
            - remove: { item: item.herb, count: 3 }
            - give: { gold: 500 }
            - set: quest.herb.done = true
            - say: "你真是幫了大忙！"
          else:
            - say: "還差一些呢。"
```

編譯後（節錄，編譯器產生，人不碰）：

```json
[
  {"code":111,"indent":0,"parameters":[0,3,0,0]},
  {"code":101,"indent":1,"parameters":["Actor1",2,0,2,"藥草師"]},
  {"code":401,"indent":1,"parameters":["北邊森林有藥草…能幫我採三株嗎？"]},
  {"code":102,"indent":1,"parameters":[["好","不了"],1,0,2,0]},
  {"code":402,"indent":1,"parameters":[0,"好"]},
  {"code":121,"indent":2,"parameters":[101,101,0]},
  ...
  {"code":412,"indent":0,"parameters":[]},
  {"code":0,"indent":0,"parameters":[]}
]
```

注意 code 101 的第 5 個參數 `speakerName` — **這是 MZ 新增的，MV 沒有**。這類差異要進編譯器的測試。

### 4.3 Event command 支援分級

**Tier 1（必做，涵蓋 ~80% 用途，約 15 個）**

```
0    結束            101/401  顯示文字（+ MZ speakerName）
102/402/403/404  選項  108/408  註解
111/411/412  條件分歧  117  公共事件呼叫
121  開關操作          122  變數操作
123  獨立開關          201  場所移動
230  等待              250  播放 SE
```

（「約 15 個」以命令組計，展開的 code 數約 19 個，已於 M3 全數實作。）

**Tier 2（累計 ~95%，約 20 個）**

```
112/413/113  循環      115  中斷事件處理
118/119  標籤/跳轉     125  增減金錢
126/127/128  增減物品/武器/防具    129  成員增減
205  移動路線設定      212  動畫  213  氣球圖示
221/222  淡出/淡入     241/242  BGM
301  戰鬥處理          302  商店處理
311–318  HP/MP/狀態/回復/EXP/等級/能力/技能
355/655  腳本          357  插件指令（MZ 結構化）
```

（「約 20 個」以命令組計，展開的 code 數約 33 個；截至 M6 尚未實作，已排入 **M7.5**。）

**Tier 3（視需求，不急）**：231–235 圖片系統、261 影片、載具、281–285 地圖顯示設定、331–333 敵人操作。

MZ 的 **357 插件指令是結構化的**（plugin name + command key + 具名參數物件），比 MV 的純文字 356 好生成太多——這是把「自製系統」開放給 AI 的正確介面。

### 4.4 Validator 規則清單

**參照完整性**
- 懸空 switch / variable / item / weapon / armor / skill / actor / class / state / troop / commonEvent ID
- 傳送目的地 mapId 不存在 / 座標超出地圖邊界
- 素材檔不存在（face / character / battler / BGM / SE，含大小寫）
- tileset ID 與地圖使用的 tile 不符

**事件結構**（編譯器已保證，這裡是防線）
- 401 未緊跟 101 或前一個 401
- 111/411/412 配對與 indent 遞增
- 112/413 配對；113 不在循環內
- 402/403/404 與 102 的配對
- 缺少結尾 code 0

**語意 / 圖分析**（最有價值的一類）
- quest graph 從起點不可達的節點
- **softlock**：進入某狀態後無任何出邊
- self-switch 開啟後無任何路徑重置（重複觸發或永久失效）
- 同一 switch 被兩條任務線寫入（namespace 衝突）
- NPC 在任務 A 被移除，任務 B 仍引用
- 事件頁條件互斥性檢查（MZ 由**下往上**匹配第一個滿足的頁 — 這個順序是常見坑）
- 玩家可能取得負數金錢 / 物品

**資源**
- 未使用的 switch / variable（清理建議）
- 地圖上不可達的區域（含事件）

### 4.5 MCP 工具顆粒度

不要學參考專案做 28–35 個 CRUD 工具。原建議 12–18 個；0.2 目標改為編輯器對等（§0）後
上修為 **~20–24 個**——多出來的每一個都對應對照表的一格，不是 CRUD 細分。下方每項標註
交付的里程碑；沒標的都是 M5 已交付。

**讀（走 MCP resources 而非 tools）**
- `rmmz://project/summary`、`rmmz://map/{id}`、`rmmz://database/{table}`、`rmmz://asset-catalog`

`asset-catalog` 特別重要：MZ 內建素材是固定的（44 角色圖 / 31 tileset / 120 動畫 / 48 BGM / 345 SE），把清單當 resource 餵給模型，**它就只能從既有清單挑，不會幻想出不存在的檔名**。這一招對降低錯誤率的效果超乎比例。

**寫（宣告式）**
- `apply_script(dsl)` — 主要入口，走 L2 編譯器；唯一寫入 `list`（事件命令）的工具
- `upsert_map_event(...)` — M5 實際交付，§4.5 規劃時漏列：full-replace 一個事件的
  metadata + pages（condition/trigger/image），刻意不碰 `list`，避免「移動 NPC 一格」
  誤刪對話（新頁繼承舊頁的 `list`，新增頁才是空的）
- `upsert_database(table, entries)` — 走 schema 驗證，shallow merge 到既有列或
  `IdAllocator` 配新 ID
- `update_system(patch)` — **M6.5**：System.json 是單一 object，走 shallow merge 而非列模型
- `create_map(spec)` / `resize_map(...)` / `paint_tiles(...)` — **M7 已交付**：地圖生命週期與繪製原語
- `set_tile_flags(tilesetId, tiles)` — **M7 已交付**，§4.5 規劃時漏列：逐格通行度／地形標籤。
  `upsert_database` 只能整包換掉 8192 長的 `flags`，呼叫端手寫不出來也不該手寫
- `compose_map(spec)` — **M7 已交付**，走 L3.5（BSP，非 prefab 拼接，理由見 M7 實作結果）
- `manage_plugins(...)` — **M7.6**：js/plugins.js 條目的讀寫/啟停
- `import_asset(...)` — **M7.6**：複製素材進 img/、audio/ 正確子目錄
- `allocate_namespace(name, counts)`

**驗證 / 測試**
- `validate()` — M5 已交付（`@rmmz-kit/validate`）
- `simulate_battle(spec)` — **M6** 已交付（`@rmmz-kit/battlesim`），對 session 的記憶體狀態跑，
  未 commit 的改動也能先問「這樣平衡壞了沒」
- `playtest(scenario)` — **M8 前段**（起站台開瀏覽器）＋ M8 本體（headless 斷言），目前不存在
- `coverage()` — **M8**，目前不存在

**事務 / 專案**
- `commit(message)`、`rollback()`、`diff()`
- `create_project(template)` / `deploy(target)` — **M11**，目前不存在

### 4.6 為什麼不能走 rein 的 playtest 路線

`mz_driver.js` 的做法是 `keyboard.press('ArrowUp')` + `setTimeout(200)` 走路、靠 DOM 文字比對點 UI（原始碼註解自己寫 "This is a heuristic, might need adjustment"）。問題：

- MZ 的畫面是 **canvas**，DOM 裡沒有 UI 文字，文字比對本質上不可靠
- 靠 sleep 同步 = 隨機失敗，且慢
- 沒有加速 = 一場測試數分鐘
- 沒有固定亂數 = 不可重現

替代路線是**繞過 UI 直接操作遊戲狀態機**（`__AT.runEvent()` 而非「走過去按 Enter」）。犧牲的是「輸入層」的覆蓋（按鍵綁定、選單操作），那部分本來就不是 AI 生成內容的 bug 來源。

---

## 5. 依賴與技術選型

| 用途 | 選擇 | 理由 |
|---|---|---|
| 語言 | TypeScript (Node 20+) | 兩個參考專案都是；MZ 本身是 JS，測試插件可共用型別 |
| 測試 | Vitest | rein 已有 CI 可搬 |
| 瀏覽器自動化 | **Playwright**（不是 Puppeteer） | 內建等待策略、trace viewer、CI 支援較好。rein 用 Puppeteer，移植成本低 |
| 本地站台 | `serve-handler` + `http` | 搬 rein 的 |
| DSL 格式 | YAML（`yaml` 套件） | LLM 產出 YAML 的正確率高於 JSON，且可讀 |
| Schema 驗證 | Zod | 型別與執行期驗證共用一份定義 |
| 版本控制 | 直接 shell 出去呼叫 `git` binary（~~`simple-git`~~） | 取代 `.bak` 備份機制；改用 binary 是因為測試本來就要求 PATH 上有 `git`，省一個依賴 |

---

## 6. 風險登記表

| ID | 風險 | 影響 | 機率 | 對策 |
|---|---|---|---|---|
| **R1** | MZ 是封閉軟體，JSON 格式與編輯器快取行為無官方 spec，全靠逆向 | 高 | 中 | 把所有格式假設集中在 L0 一個模組；建 golden file 測試；版本更新後跑一次。0.2 目標改為取代編輯器後，「寫出的檔案編輯器可無損開啟」從 nice-to-have 變**硬約束**（編輯器仍是人的 fallback），golden 涵蓋面隨 M6.5/M7 擴到 System / Tilesets / Map |
| **R2** | M8 headless 測試框架超出預估 | 高 | **高** | M6 先做戰鬥模擬器取得部分價值；M8 設 timebox，超過 10 週就降級為「只跑事件層測試、不跑畫面」 |
| **R3** | 編輯器同時開啟導致修改被覆蓋 | 中 | 高 | M1 就做 editor lock 偵測；文件明確警告 |
| **R4** | repair loop 振盪把專案改爛 | 高 | 中 | git 分支隔離 + 迴歸測試 + 振盪偵測 + 次數上限 |
| **R5** | 地圖生成美觀度不達標，Lv4 卡住 | 中 | 中 | prefab 路線（人工做模板）是保底；純程序生成當 stretch goal |
| **R6** | MZ 內建素材**僅授權用於 MZ/MV 專案** | 低（本計畫）/ 高（Lv10） | — | 本計畫範圍內無影響；商業化路線需另行處理 |
| **R7** | 復合成功率塌陷（各層 85% 串起來變 40%） | 高 | 高 | 這正是 M9 repair loop 存在的理由——它不是加分項，是讓復合成功率不塌的必要條件 |
| **R8** | M5 交付的 MCP 工具層沒有 `gameStateInspector` 式的白名單（§2.2），`apply_script` 能寫入任意 DSL | 中 | 中 | 目前僅在受信任的單機 agent 情境使用；若要對外開放或多租戶，補一層 production 白名單再上線 |
| **R9** | autotile shape bits 與 Tilesets 通行 flags 無官方 spec，算錯的地圖在編輯器裡直接顯示破圖 | 中 | 中 | 對照編輯器實際輸出建 golden fixture（在編輯器手畫樣張、比對本工具輸出）；M7 驗收含「編輯器開啟顯示正確」 |

---

## 7. 關於 Lv10

Lv10（長篇商業 RPG 全自動）**刻意不在本計畫範圍內**，理由是它的瓶頸不在工具鏈：

- 美術/音樂的原創性與授權
- 20–60 小時尺度的伏筆回收與角色弧線（模型的長程一致性做不到）
- 商業作品的賣點通常是自製戰鬥/成長系統 = 大量客製插件 JS，那是軟體開發不是內容生成

建議把 Lv10 重新定義為「**AI 輔助的商業開發流水線**」：本計畫的 M0–M9 全部完成後，人力可望從 100% 降到 40–60%。這個目標的達成率反而有 80%+，而且**不需要額外架構**。

---

## 8. 下一步

M0–M6 已完成（見 `CLAUDE.md` status）。§8 原本的「起手三步」已全部達成，改列目前真正的下一步：

1. ~~**決定 issue #7**~~：已解決 — 五個套件都加了 `exports` map（`rmmz-kit-source`
   自訂 condition 指向 TS 原始碼，`default` 指向 `dist/`），外加 `tsconfig.base.json`
   的 `customConditions` 與 `vitest.config.ts` 的 `resolve.conditions`。
   `npm run build` 後 `node packages/mcp/dist/bin.js <project>` 可直接被
   Claude Desktop 這類 stdio client 接上。
2. **M6.5 資料庫完備**：編輯器對等（§0 對照表）最便宜的一格——`tables.ts` 加三表 +
   `update_system`，半週。
3. **M7 地圖**：先做 L0 create-file 前置，再 `create_map` / `paint_tiles` / autotile /
   通行度，後半接原地圖合成。
4. **M7.5 Tier 2 → M7.6 插件與素材 → M8（前段先交付 playtest）→ M11 部署**，順序見
   §3.1；M8 投入前照 §6 R2 確認 timebox。
5. 若要對外開放 MCP 工具層（而非僅本機 agent 使用），先處理 §6 R8（白名單缺口）。
