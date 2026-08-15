# `templates/`

`blank-project/` is the tree `create_project` copies (`packages/core/src/createProject.ts`).
It is checked-in **data**, not code that builds a project: "change the default currency
unit" should be a JSON edit.

It lives one directory above the template so it is not copied into every created project.

## `blank-project/data/System.json` is a crash list, not a preferences file

The engine dereferences several System.json fields **with no guard**, so a missing one is a
TypeError on boot rather than a missing feature. `types/mz.ts`'s `SystemData` is deliberately
only a *subset* of what MZ writes, so this file is the only place those extra fields exist.

**Before adding or removing a field here, read how corescript uses it.** The ones currently
known to be load-bearing, with their call sites:

| field | read by | if missing |
| --- | --- | --- |
| `titleCommandWindow` | `Scene_Title.createCommandWindow` — `rmmz_scenes.js:579` (`.background`), `:590`/`:591` (`.offsetX`/`.offsetY`) | TypeError on the **first** scene — the game never reaches a map |
| `advanced.windowOpacity` | `Game_System.windowOpacity` → `Window_Base.updateBackOpacity` | TypeError while the first window is built |
| `advanced.screenWidth` / `screenHeight` | `Scene_Boot.resizeScreen` | canvas sized from `undefined` |
| `advanced.uiAreaWidth` / `uiAreaHeight` | `Scene_Boot.adjustBoxSize` | every window laid out from `undefined` |
| `itemCategories` | `Window_ItemCategory.makeCommandList` | TypeError when the item menu opens |
| `sounds` (24 entries) | `SoundManager.loadSystemSound`, by index | TypeError on the first cursor move |

`packages/validate/src/rules/runtime.ts` keeps the same list as `REQUIRED_SYSTEM_FIELDS`;
the two are meant to be edited together, and `packages/validate/test/runtime.test.ts` pins it.

Three more fields are here because the editor writes them and a project without them is
*degraded* rather than dead — worth carrying, but not validator material:

- `optMessageSkip: true` — without it `Window_Message` never fast-forwards.
- `optSplashScreen: false` — MZ guards this one (`"optSplashScreen" in $dataSystem`).
- `battleSystem: 0` — `BattleManager.isTpb()` compares against 1/2, so a missing field
  happens to behave like turn-based. Written out so that stays a decision, not a coincidence.

## What is deliberately *not* here

No art, no audio, no `js/rmmz_*.js` — all three ship with the paid editor. Every asset-name
field in System.json (`title1Name`, all 24 `sounds`, every vehicle) is therefore **empty
rather than a plausible default**: a plausible filename would be a dangling reference the
validator is right to report. `create_project --runtimeFrom <an installed project>` is how a
licensed machine fills the gap.
