# 授權機器驗證報告(2026-08)

plan §8.3 說有六個缺口「本 repo 內做不完,缺付費編輯器或真實模型」,並說這六項共用一個收尾動作:
在一台裝了授權 RPG Maker MZ 的機器上跑一輪。**這份文件是那一輪的紀錄。**

結果不是六項全關,而是三種不同的答案 —— 兩項關掉、一項量化、一項部分推翻、兩項原地不動 ——
外加**八個真實缺陷**,其中一個是 `create_project` 產出的專案根本開不了機。

八條全部已修或已明確界定;每條下面都標了對應的 commit。

**環境** Windows 10 Pro 19045 · node v24.16.0 · git 2.55.0(本次由 2.28.0 升級)· RPG Maker MZ 1.9.x
**基底** `master` + eight-gaps 的 5 個 commit(branch `verify/eight-gaps`)

> **語料的授權界線。** T5 用的是 MZ 安裝目錄裡編輯器自己寫出來的 `samplemaps` / `newdata`。
> 那些檔案是 KADOKAWA 隨編輯器出貨的著作物,**沒有、也不會進這個 repo**。本文引用的是
> *參數形狀與結構*(那是格式事實),repo 裡的 fixture 一律是照這些形狀**手打的最小重現**
> —— 見 `packages/compiler/test/editorShapes.test.ts`。要重跑 §5 的百分比需要自己有一份安裝。

---

## 1. 結果表

| 項目 | 結果 | 摘要 |
|---|---|---|
| **T0** 前置 | ✅ | build 綠、317/317 passed(升級 git 之後)。清單的 316 基準對上 |
| **T1** `create_project --runtimeFrom` | ⚠️ **先失敗,修後通過** | runtime / validate / 伺服全對,但**產出的專案開機必當**(F2) |
| **T2** 編輯器開啟 + editor-lock | ⛔ **未執行** | 需要人在 GUI 操作編輯器 |
| **T3** 驅動 `window.__AT` | ✅(以 CDP 取代 Playwright) | headless 與真 runtime 同腳本結果一致,3 處不一致逐條記錄;另找出 `AutoTest.js` 兩個實作缺陷(F3、F4) |
| **T4** deploy 產物通關 | ✅ | web 產物在瀏覽器實際通關;windows 產物 exe 啟動進 `Scene_Title` |
| **T5** R1 / R9 golden | ✅(換語料來源) | 2498 條真實編輯器指令串。232 的 R1 假設實測成立;另找出 2 個 R1 缺陷(F5、F6) |
| **T6** battle sim 校準 | ⚠️ **±10% 部分推翻** | 6 組梯度,3 組吻合、3 組超出。用 A/B 實驗定位到兩個機制(F7、F8) |
| **T7** 新功能煙霧測試 | ✅ | 五項新功能全部在真環境驗過 |

---

## 2. T1 — `create_project --runtimeFrom`

```
create_project <target> title="Kit Game" runtimeFrom=<a project created by the editor>
→ files=2662  commit=…  warnings=[]          ← 無 "No runtimeFrom" 警告 ✅
```

- `js/rmmz_{core,managers,objects,scenes,sprites,windows}.js` 齊全;`img/`、`audio/`、`css/`、
  `fonts/`、`effects/`、`icon/`、`movies/`、`index.html` 齊全 ✅
- `RUNTIME_SKIP` 正確生效:`js/plugins.js` 是模板的空清單、`js/plugins/` 只有 `.gitkeep`,
  **沒有**繼承來源專案的範例插件 ✅
- `openProject` + `validateProject`:**0 errors**,1 warning(`runtime/map-all-passable`,空白 Map001,合理)✅
- 瀏覽器經 playtest server 進標題畫面:**一開始失敗**(F2),補 System.json 後 ✅

---

## 3. T3 — 真 runtime 驅動 `__AT`

repo 沒有 playwright 依賴,改用 Chrome DevTools Protocol 驅動同一個 `window.__AT` ——
協定不同,驅動對象與斷言完全相同。

語料:在授權專案上跑 `generate_game`,生成 2 區域 / 2 任務 / 1 頭目的小遊戲,
劇本用它自己產生的 walkthrough / gates 兩支 scenario。

真 runtime 重演:**walkthrough 25 個斷言中 23 個 PASS,gates 5 個全 PASS**,
遊戲在真引擎中從新遊戲一路打到 clear switch。

### 3.1 逐條不一致

| # | 位置 | headless | 真 runtime | 成因 |
|---|---|---|---|---|
| 1 | 任務 2 交件後 gold | 150 | **155** | `answerBattles` 只給戰鬥**分支結果**,不給戰鬥**獎勵**。真 runtime 掉了 5G |
| 2 | 頭目戰後 gold | 150 | **170** | 同上 |
| 3 | 訊息集合 | 只有 Show Text | 多出戰鬥訊息與 **一次升級** | 同上 |

三處同源:`packages/playtest` 的事件層 runtime 依設計把 Battle Processing 當成「告訴我結果」,
不模擬 `BattleManager.makeRewards`。**升級**是 headless 完全看不到的狀態變化,對「後面那場仗還平衡嗎」
有實質影響。而 gold / EXP / 等級**不是計進 `unmodeled` 的,而是靜靜地不發生**。

> **已處理**(commit `docs+feat(playtest): record what the licensed-machine run actually settled`):
> `ScenarioReport.notes` 在有戰鬥獲勝時會說明獎勵未建模。刻意不放進 `unmodeled` ——
> 那個計數器的意思是「某條指令被跳過了」,被稀釋之後讀者就會學會忽略它。

---

## 4. T4 — deploy

### web

```
files=503  bytes=23,390,764  pruned=811
warnings: [ "Assets referenced only from plugin code ... cannot be detected",
            "AutoTest.js is in this build — window.__AT lets anyone drive the game." ]   ✅
```

排除檢查(全 ✅):專案標記檔 / `save/` / `*.rmmzsave` / `data/RmmzKitNamespaces.json` / `.git` 皆不在產物內。

**實際遊玩**(瀏覽器,經 `startPlaytestServer` 服務產物目錄):
標題 → 用真的 Title 指令視窗選 New Game → **按方向鍵真的走了 3 格,往牆壁走被擋住** → 觸發任務 →
**真的打了一場 `Scene_Battle` 並獲勝** → 存檔 → 重新載入頁面 → 用真的 Continue 讀檔 →
地圖 3 @(18,9)、gold 55、switch 1–6 全數還原。✅

> **清單措辭更正:`playtest` 工具本身不能服務 deploy 產物** —— `openProject` 會因為產物刻意不含
> 專案標記檔而拒絕。底層的 `startPlaytestServer(rootPath)` 沒有這個限制。

### windows

```
nwPath = <MZ install>/nwjs-win      (編輯器自帶,無須從 nwjs.io 下載)
files=651  bytes=344,765,748
產物:Kit Verify.exe / www/ / package.json   ✅
CDP 探針:scene=Scene_Title  canvas=[816,624]  document.title="Kit Verify"
          $dataSystem.gameTitle="Kit Verify"  SceneManager._error=undefined   ✅
```

兩個非阻斷觀察,**兩者都已修**(commit `fix: the verification run's small findings`):

- **啟動瞬間視窗標題是舊專案名**。`deploy` 寫的根 `package.json` 正確,但專案自己的
  `package.json` 與 `index.html` 的 `<title>` 被原封複製進 `www/`,
  要跑到 `Scene_Boot.updateDocumentTitle` 才改過來。
- NW.js shell 是整包複製,`chromedriver.exe` / `nwjc.exe` / `payload.exe` /
  `notification_helper.exe` 都進了產物(344MB)。出貨遊戲附 chromedriver 值得一個警告。

---

## 5. T5 — R1 / R9 golden

清單原本要人在編輯器手畫樣張。改用安裝目錄裡**編輯器自己寫出來的資料**,語料大得多也更有代表性:

| 語料 | 檔數 | 指令串 | 指令數 | decompile 失敗 | 逐位元組 round-trip |
|---|---|---|---|---|---|
| `samplemaps/` | 293 | 2441 | 4422 | **1** | 2377 / 2440(97.4%) |
| `newdata`(Playable tutorial) | 5 + CommonEvents | 61 | 483 | **4** | 52 / 57(91.2%) |

### 5.1 ✅ Move Picture `params[1]` — 清單最重要的一項,假設成立

`ir.ts` 的註解原本寫「this repo has no editor-written 232 to copy」—— 現在有了,10 個,
而且全部符合表項預設。

```
=== 編輯器的 8×231 / 10×232 / 7×235 丟進 decompile() ===
typed DSL steps produced : {"showPicture":8,"movePicture":10,"erasePicture":7}
picture codes left as raw: (none)
編輯器 bytes → decompile → YAML → parseDsl → compile,逐位元組相同:2/2
```

**`matchesSimple` 的 typeof 檢查沒有把任何一個編輯器寫的 232 退回 RawNode**;
巢狀陣列的 234 也照設計留在 RawNode 並完整 round-trip。

### 5.2 編輯器實際寫出的參數形狀

```
231 (8)   types=["number","string","number","number","number","number","number","number","number","number"]
          = [pictureId, name, origin, xyType, x, y, scaleX, scaleY, opacity, blendMode]
232 (10)  13 個元素;params[1] 恆為 number 0;params[11] 是 boolean;params[12] 是 number
235 (7)   types=["number"]
233 / 234 / 236 : 兩份語料都沒有出現,需要人在編輯器補畫
```

### 5.3 F5 — `decompile()` 拒絕真實編輯器輸出(5 條指令串)

```
samplemaps/Map105.json#event 22 page 1 : Expected code 412 at indent 0 at index 3, got code 0 indent 1
newdata/Map003.json#event 5 p1 / #event 7 p1 / #event 7 p2 / #event 9 p1
```

編輯器**在 Conditional Branch 的分支主體末端也寫了 `{code:0}` 填充**,indent 與主體同層:

```jsonc
{"code":111,"indent":0,"parameters":[…]},         // 條件分支
{"code":250,"indent":1,…},
{"code":201,"indent":1,…},
{"code":0,  "indent":1,"parameters":[]},          // ← 編輯器寫的填充,decompile 不接受
{"code":411,"indent":0,"parameters":[]},          // Else
{"code":250,"indent":1,…},
{"code":201,"indent":1,…},
{"code":0,  "indent":1,"parameters":[]},          // ← 同上
{"code":412,"indent":0,"parameters":[]},
{"code":0,  "indent":0,"parameters":[]}
```

repo 當時只在 Show Choices(402/403)容忍這個填充。MZ 的 `Game_Interpreter` 對 `code:0`
沒有 handler,執行時無害。

**影響**:這種事件在 rmmz-kit 眼中是壞的 —— `rmmz://map/{id}` 讀不出來、`apply_script` 改不了、
`validate` 的 `structure` 規則**誤報**、`run_scenario` 把它列進 `unparsed`。
對「拿現成專案來改」這個主要使用情境,會踩到。

> **已修**(commit `fix(compiler): decompile the editor's {code:0} filler in a branch body`):
> 每一個 block parser 開出來的 body 尾端都容忍這個填充(111/411、112、RawNode body);
> emit 不回寫,所以這類指令串 round-trip 回來是**語意相同、非逐位元組相同**。

### 5.4 F6 — `emit()` 的 Set Movement Route 505 鏡像多寫一列

68 條不逐位元組相同的指令串**全部是 205 Set Movement Route**,差異只有一類:

```
編輯器:一條 route 的 list 有 N 個元素(含結尾 {code:0}),寫 N-1 列 505
工具  :寫 N 列 505 —— 連結尾的 {code:0} 也鏡像了一列
```

實例:編輯器 32 列、工具 33 列,**多出來的 505 把後面所有指令位移一格**。

另有三個純格式差(未修,無行為影響):route step 的 `indent` 編輯器有時整個省略、
step 與 route 物件的 key 順序不同。

**影響**:`Game_Interpreter.command505` 是 no-op,遊戲執行沒差;
但**編輯器的事件指令列表是照 505 列渲染的**,多一列會多出一行空白。

> **已修**(commit `fix(compiler): one 505 mirror row per route step, none for ROUTE_END`)。
> 這也把 CLAUDE.md 那句「idempotent but not always byte-identical」量化了:
> 對真實編輯器輸出 **97.4% 逐位元組相同**,不同的 2.6% 是 205 鏡像(已修)與分支填充正規化。

---

## 6. T6 — battle sim 校準

同一個授權專案的內建資料庫,6 組梯度。sim 每組 1000 trials(seed=1);真 runtime 每組 20–40 場,
`BattleManager.setup(troopId, false, true)` + `isAutoBattle`,**每場重建 `$gameActors`**
以免 EXP / 等級 / 已學技能污染。

| # | 對局(全部 L1) | sim 勝率 | 真 runtime 勝率 | Δ pp | sim 回合 | 真 回合 |
|---|---|---|---|---|---|---|
| A | 4 人 vs 小怪×2 | 100.0% | **100.0%** (20/20) | 0 | 2.10 | 1.90 |
| B | 1 人 vs 小怪×2 | 62.2% | **77.5%** (31/40) | **+15.3** | 5.63 | 5.95 |
| C | 1 人 vs 中怪 | 66.0% | **55.0%** (22/40) | **−11.0** | 6.72 | 6.80 |
| D | 1 人 vs 強敵 | 0.0% | **0.0%** (0/20) | 0 | 5.40 | 5.15 |
| E | 2 人 vs 強敵 | 87.7% | **100.0%** (30/30) | **+12.3** | 8.10 | **5.47** |
| F | 4 人 vs 強敵 | 100.0% | **100.0%** (20/20) | 0 | 4.60 | 4.45 |

**結論:「誤差 < 10%」在兩端(必勝/必敗)完全成立,在勝負接近的中段不成立。** 3/6 超出。

傷害算術本身是對的 —— B 組逐發比對:敵方每擊 sim mean 60.0 / median 60,
真 runtime mean 60 / median 60,**完全吻合**;命中率 sim 91.3% vs 真 87.7%;回合數也吻合。
差在**誰先死**,而那是策略,不是公式。

### F7 — 行動目標選擇(解釋 B 組)

`resolveTargets` 的 scope 1 是**在存活敵人中均勻隨機**,兩邊都用。
MZ 的 `makeAutoBattleActions` 走 `Game_Action.evaluate()`,實質上是**集火** ——
先打死一隻,進來的傷害就腰斬。

**A/B 實驗**(保留 MZ 引擎,只把玩家方目標選擇換成模擬器的均勻隨機):

| B 組 | 勝率 | 對 sim 的 Δ |
|---|---|---|
| 模擬器 | 62.2% | — |
| 真 runtime,**改成隨機目標** | **70.0%** (28/40) | **+7.8,回到 ±10% 內** |
| 真 runtime,MZ 原本的集火 | 77.5–81.8% | +15.3 ~ +19.6 |

`BattleReport.policy` 當時只描述**技能**選擇,沒提**目標**選擇。

> **已界定**(commit `feat(battlesim): report target selection, and let a caller bracket it`):
> `targetPolicy: 'random' | 'focus'` 給出上下界,`policy` 說明用了哪一個並指向另一個。
> 完整的 `evaluate()` 建模刻意不做 —— 那要把每個技能對每個 battler 的價值都建模,是 L5 規模的工作。

### F8 — `attackTimesAdd()`(解釋 E 組的回合數 8.10 → 5.47)

E 組只有一隻敵人,目標選擇無關。逐發記錄顯示**一名角色的行動次數是另一名的整整兩倍**(56 : 28),
來源是初始武器帶了 `TRAIT_ATTACK_TIMES`(code 34)`value: 1`:

```js
// MZ
Game_Action.prototype.numRepeats = function() {
    let repeats = this.item().repeats;
    if (this.isAttack()) repeats += this.subject().attackTimesAdd();   // ← 這一行
    return Math.floor(repeats);
};
// simulate.ts(當時)
const repeats = Math.max(1, used.repeats);   // 只讀技能列的 repeats
```

這是**可直接修的公式缺口**(不是策略),而且 MZ 內建武器就有。
CLAUDE.md 的 unmodeled 清單當時列的是「extra action times (trait 34)」——
那是把兩件事混在一起,而且 code 標錯了。

> **已修**(commit `fix(battlesim): count attackTimesAdd() in numRepeats`):
> extra **attack** times(34)已建模,extra **action** times(61)仍未建模,兩者分開列。

### 方法論教訓

第一輪用 `changeLevel(1, false)` 重設等級,結果 **MZ 降級不會遺忘已學技能**,
角色從第二場起帶著 L2 才會的技能打 L1 的仗,B 組被高估到 90%。
任何要在真 runtime 做重複對局的人都會踩到:必須清 `$gameActors._data` 重建角色。

---

## 7. T7 — 五項新功能的真環境驗證

| 子項 | 結果 |
|---|---|
| `import_asset` 真 `.ogg` / `.png` | ✅ staged → commit → 真 runtime `fetch` 200、實際播放/顯示 |
| 副檔名 / 未知資料夾守衛 | ✅ 都被拒且訊息可操作 |
| `manage_plugins` 啟用真插件 | ✅ 追加新插件、保留既有項、保留編輯器 header;真 runtime `PluginManager._scripts` 都在 |
| `manage_plugins` 缺檔守衛 | ✅ `No such plugin: js/plugins/NoSuchPlugin.js.` |
| **`import_asset` 進 `js/plugins`** | ✅ 匯入 `.js` 後**同一個 session 內** `manage_plugins` 就能啟用;`.ogg` 被拒。這是插件工作流真正缺的一環 |
| **`delete_map`** | ✅ 見 7.1 |
| **新 reference 規則** | ✅ 見 7.2 |
| **`deploy target=macos`** | ✅ 見 7.3 |
| **Tier 3 DSL 演出** | ✅ 見 7.4 |

### 7.1 `delete_map` — 三種拒絕都對,而且點名來源

```
map 2  (starting map)          → refused: Map 2 is the starting map (System.startMapId) — repoint it before deleting
map 3  (transfer points at it) → refused: Map 3 is still referenced:
                                 Map002.json > event 1 > page 1 > command 2 (code 201)
map 99 (does not exist)        → refused: No such map: Map099.json

map 1  (乾淨)                   → {"deleted":"Map001.json"}
                                  MapInfos[1] = null      dirty: MapInfos.json
session.rollback()             → 檔案在磁碟上復活,session 也重新列出它
```

驗收要求的「錯誤訊息點名來源」達成 —— 不只說「還有人指向它」,而是給出
`檔案 > 事件 > 頁 > 指令` 的完整編輯位址。新的 `deleteFile` transaction verb 兩端都對。

### 7.2 新 reference 規則 — 六個注入的懸空 id,抓到五個

```
[error] references/dangling-weapon / -armor / -skill / -state / -actor   ✅
showAnimation 的 animationId → 無 finding(不在該 patch 宣告的範圍內)
真實專案(未注入):0 errors —— 沒有誤報
```

> **已補**(commit `fix: the verification run's small findings`):`dangling-animation`。
> 懸空的 animationId 是 `Sprite_Animation` 在事件播放的那一幀對 `undefined` 讀 `effectName`。

### 7.3 `deploy target=macos` — 產物結構

```
files=676  bytes=377,514,091  pruned=810

Kit Verify.app/Contents/
  Info.plist                            ✓
  MacOS/nwjs                            ✓
  Resources/app.nw/                     ✓  audio css data effects fonts icon img
                                           index.html js movies package.json
  Resources/app.nw/package.json  {"name":"Kit Verify","main":"index.html", …}
  game marker 已排除                     ✓
warnings 含 codesign 提醒                ✓
```

`main` 對兩種殼各自正確(macOS 是相對於 `app.nw` 的 `index.html`,Windows 是相對於根的 `www/index.html`)。
**實際能否啟動要在 Mac 上驗**,仍待辦。

### 7.4 Tier 3 DSL 演出 — 真 runtime 逐幀量測

把先前用 `raw:` 寫的演出改成 DSL 糖重寫,emit 出來的參數陣列與編輯器形狀一字不差,然後在真引擎跑:

```
- movePicture: {x:200, y:150, scaleX:50, opacity:128, duration:30, wait:true, easingType:2}
  frame 11 : x=394 y=301 s=96.7 op=247    起步快
  frame 40 : x=200 y=150 s=50   op=128    收尾慢,恰好 30 幀走完;wait:true 擋住直譯器

- rotatePicture: {pictureId:1, speed:15}
  frame 41 : angle=7.5   frame 46 : angle=45.0   frame 52 : angle=90.0
                                                 = speed/2 度/幀,與 MZ 一致
```

座標、origin、四段 easing、wait 開關、erase 全部正確,
**連編輯器語料裡完全沒出現過的 233 rotatePicture 也對**。
同一段演出在 Tier 3 表項之前也用 `raw:` 逃生口跑過一次,數值完全相同 ——
**只是換了書寫層,沒有改變送進引擎的位元組**。

---

## 8. 缺陷清單

### F2 —【高】`create_project` 產出的專案開機必當 · 已修

`templates/blank-project/data/System.json` 缺 `titleCommandWindow`,MZ 無 fallback 直接解參考:

```js
// js/rmmz_scenes.js:579 / 590 / 591
const background = $dataSystem.titleCommandWindow.background;   // TypeError
```

實測:`create_project --runtimeFrom`(runtime 齊全、`validateProject` **0 errors**)在瀏覽器
`Scene_Boot → Scene_Splash → Scene_Title.create()` 丟
`TypeError: Cannot read properties of undefined (reading 'background')`,
**永遠進不了標題,遊戲不可玩**。

| 欄位 | 編輯器值 | 引擎讀法 | 缺了會怎樣 |
|---|---|---|---|
| **`titleCommandWindow`** | `{"background":0,"offsetX":0,"offsetY":0}` | `rmmz_scenes.js:579/590/591` 直接解參考 | **開機 TypeError** |
| `optMessageSkip` | `true` | `rmmz_objects.js:228` | undefined → falsy,**訊息不能跳過** |
| `battleSystem` | `0` | `rmmz_managers.js:2311/2315` | undefined 比較為 false → 落回回合制,對但屬巧合 |
| `optSplashScreen` | `false` | `rmmz_scenes.js:454` | undefined → falsy,可接受 |
| `faceSize` / `iconSize` | `144` / `32` | 有 `in` 守衛 | 安全 |
| `advanced.screenScale` / `.picturesUpperLimit` | | 有 `in` 守衛 | 安全 |

**連帶 F2b【中】**:`packages/validate/src/rules/runtime.ts` 自述是「a short list of *named crashes*」,
`titleCommandWindow` 正是這一類、而且比已列的 `advanced.windowOpacity` 更嚴重(直接丟例外),
卻沒被列;實測對這個必當的專案回 **0 errors**。

> **已修**(commit `fix(core+validate): create_project's output crashed in Scene_Title`):
> 模板補四欄、規則清單補 `titleCommandWindow`、新增 `templates/README.md` 作為
> 「引擎會無守衛解參考的欄位」對照表。兩半必須一起修 —— 只修一邊仍然會出貨這個 bug。

### F3 —【中】`AutoTest.js` 在非前景分頁無聲空轉 · 已修

```js
// js/rmmz_managers.js:2143
SceneManager.updateScene = function() {
    if (this._scene) {
        if (this._scene.isStarted()) {
            if (this.isGameActive()) {      // ← window.top.document.hasFocus()
                this._scene.update();
```

自動化分頁 `document.hasFocus()` 是 `false`,於是 `Graphics.frameCount` 照加、直譯器完全不動。

實測:`__AT.step(300)` → frameCount 524→**824**,場景仍停在 `Scene_Splash`;
`__AT.waitIdle(300)` 跑滿 300 幀回 **`false`**,呼叫端只看到逾時、看不到原因。

這正是 plan §3 M8 known-traps 表「rAF vs logical frames」那一列的實體,
而 §4.6「繞過 UI 直接驅動狀態機」的整個設計被這一行守衛擋掉。

### F4 —【中】`__AT.waitIdle()` 過不了跨地圖傳送 · 已修

`waitIdle()` 是同步 `for` 迴圈,而 `DataManager.loadMapData` 是 `fetch` —— 回應永遠排不進去。

實測:`teleport(3,18,9)` 後 `waitIdle(600)` 在 **35 ms** 內燒完 600 幀回 `false`,
還停在原地圖、`isTransferring()===true`;同樣的等待改成每幀讓出事件迴圈,754 幀就完成。
任何 transfer 密集的劇本在真 runtime 都會卡在這裡。

**不能用 `setTimeout`** —— 背景分頁會被鉗到 1 秒;`MessageChannel` 不受鉗制,本次驗證全程用它。

**F4b【低】**:`__AT` 也沒有「開新遊戲」與「回答選項」的 API,驅動端只能自己打
`DataManager.setupNewGame()` 與去驅動 `Scene_Message._choiceListWindow`。

> **F3 / F4 / F4b 已修**(commit `fix(playtest): AutoTest.js was a no-op under any driver`):
> `step`/`waitIdle` 覆寫 `isGameActive` 並在 `finally` 還原;`waitIdle` 改為 async 且用
> `MessageChannel` 讓出 macrotask;新增 `newGame()` 與 `answerChoice(index)`。
> **這兩條的意義超過它們自己**:stub 測試從頭到尾都是綠的,而外掛在它唯一存在目的的環境裡完全沒作用。
> stub 沒有 `updateScene` 可以跳過幀,也沒有 fetch 可以餓死。

### F5 —【中】`decompile()` 拒絕真實編輯器輸出 · 已修 — 見 §5.3
### F6 —【低】`emit()` 的 505 鏡像多寫一列 · 已修 — 見 §5.4
### F7 —【中】battlesim 目標選擇政策未在 `policy` 說明 · 已界定 — 見 §6
### F8 —【中】battlesim 未計 `attackTimesAdd()` · 已修 — 見 §6

### F1 —【中】`createProject.test.ts` 在 git < 2.32 必失敗 · 已修

該測試靠設 `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` 指向不存在的檔來偽造「無 git 身分」。
這兩個環境變數是 **git 2.32** 才引入的;git 2.28 直接忽略,於是測試讀到開發者真正的身分並失敗 ——
失敗訊息(「expected false to be true」)完全指不出原因,而且它指控的是一份**正確**的實作。

本機已升級 git 到 2.55,但這條仍值得防護。

> **已修**(commit `fix: the verification run's small findings`):測試前置偵測 `git --version`,
> < 2.32 時 skip 並說明原因。
>
> *安裝時的實務提醒:Git for Windows 的 Inno 安裝程式會因為任何開著的 `bash.exe` 而中止,
> 而那正是本工具鏈自己的 shell。*

### 其他小事(全部已處理)

- `ir.ts` 的 232 註解說「this repo has no editor-written 232 to copy」—— 本次提供了 10 個。
  已改寫為「已對語料的 10 個編輯器 232 驗證,`params[1]` 恆為 0」,並註明 233/234 兩份語料都沒出現、仍是假設。
- `packages/battlesim/src/simulate.ts` 註解裡有一個游離字 `ponytail:`,顯然是誤植。已刪。
- `packages/core/src/io/projectRoot.ts` 註解說「the editor writes `Game.rmmzproject`」,
  而 MZ 1.9.x **實際寫的是小寫 `game.rmmzproject`**。行為沒問題(查找大小寫不敏感),
  但註解把理由講反了。已更正。
- `create_project` 的 `Tilesets.json` 只有一列空白 tileset,所以即使 `runtimeFrom` 把全部美術複製進來,
  新專案還是畫不出任何地形。已加 warning;`runtimeFrom` 要不要順帶帶入 `Tilesets.json`
  牽動 `RUNTIME_SKIP` 的資料/程式邊界,是產品決策,留給維護者。
- `create_project` 的 `title1Name` 留空是有意的,但 `runtimeFrom` 之後 `img/titles1/` 已經有圖,
  此時空字串換來純黑標題。**未處理**,理由同上。

---

## 9. 仍需人在 GUI 前面

| 項目 | 需要的動作 |
|---|---|
| **T2 全部** | 用編輯器開產出的專案;確認地圖樹正常、內建 Playtest 可啟動;然後開著編輯器存個檔,用工具 `commit()` 驗 drift 拒絕 |
| **T5 的 233/234/236** | 兩份 MZ 樣本語料都沒有這幾個指令,要人在編輯器補畫一個樣張 |
| **T5 的 Tier 1/2 完整覆蓋** | 兩份語料合計只出現數十種指令碼;要「每個 Tier 1/2 指令至少一個實例」仍需人工樣張 |
| **`delete_map` 後編輯器重開** | 刪除、MapInfos 設 `null`、rollback 復活都已驗;用編輯器確認地圖樹仍需人操作 |
| **windows 產物實際遊玩** | exe 已確認啟動並進 `Scene_Title`(CDP 探針),但沒有人在畫面前實際玩過一輪 |
| **macOS 產物實際啟動** | 產物結構、`app.nw` 內容、`Info.plist`、codesign 警告都已驗;能否啟動要在 Mac 上跑 |

M9(修復率)與 M10(一句話→spec)這一輪**沒有跑**:它們的前提是一個真實模型,不是一台授權機器。

---

## 附錄:這一輪留下但不進 repo 的東西

驗證用的腳本、原始輸出、以及 T5 的候選 golden 樣張都留在工作機的 `verify-tmp/`,
**刻意不進版本控制**:`golden/` 是 KADOKAWA 隨編輯器出貨的著作物。

repo 裡取而代之的是照本文記錄的形狀**手打的最小重現**
(`packages/compiler/test/editorShapes.test.ts`)。
要重跑 §5 的百分比,需要自己有一份授權安裝。
