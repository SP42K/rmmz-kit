// Generate a demo game with @rmmz-kit/gamegen and dump the resulting project
// data (in memory, never committed) plus the report, for embedding in a page.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openProject } from '@rmmz-kit/core';
import { generateGame, GameSpecSchema } from '@rmmz-kit/gamegen';
import { analyzeReachability, checkPassage } from '@rmmz-kit/mapgen';

const REPO = '/home/user/rmmz-kit';
const OUT = process.argv[2];
const project = path.join(path.dirname(OUT), 'demo-project');

fs.rmSync(project, { recursive: true, force: true });
fs.cpSync(path.join(REPO, 'fixtures/minimal-project'), project, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: project });
execFileSync('git', ['add', '-A'], { cwd: project });
execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=demo', 'commit', '-qm', 'baseline'], { cwd: project });

const spec = {
  title: '藥草與洞窟 (rmmz-kit demo)',
  seed: 7,
  party: JSON.parse(process.env.PARTY ?? '[1,2]'),
  areas: [
    {
      key: 'village',
      name: '風車村',
      width: 30,
      height: 22,
      connects: ['forest'],
    },
    {
      key: 'forest',
      name: '低語森林',
      width: 34,
      height: 24,
      connects: ['cave'],
    },
    {
      key: 'cave',
      name: '回聲洞窟',
      width: 30,
      height: 22,
    },
  ],
  quests: [
    {
      key: 'herb',
      title: '採集藥草',
      giver: { area: 'village', name: '老藥師' },
      objective: { kind: 'fetch', area: 'forest', name: '藥草叢', item: 1, count: 1, text: '你摘下一株藥草。' },
      reward: { gold: 120 },
      lines: { offer: '森林裡有藥草，幫我摘一株回來好嗎？', complete: '太好了，這正是我要的。' },
    },
    {
      key: 'scout',
      title: '洞窟探路',
      giver: { area: 'forest', name: '守林人' },
      requires: ['herb'],
      objective: { kind: 'talk', area: 'cave', name: '迷路的礦工', text: '洞窟深處有東西在動……小心點。' },
      reward: { gold: 80, itemId: 1, itemCount: 2 },
      lines: { offer: '有人進了洞窟就沒回來，去看看吧。', locked: '你先去幫老藥師的忙。' },
    },
    {
      key: 'slimes',
      title: '清理史萊姆',
      giver: { area: 'cave', name: '迷路的礦工' },
      requires: ['scout'],
      objective: { kind: 'defeat', area: 'cave', name: '成群的史萊姆', troop: 2, text: '牠們擋住了出口！' },
      reward: { gold: 200 },
    },
  ],
  finale: {
    name: '洞窟食人魔',
    area: 'cave',
    troop: 3,
    lines: { locked: '巨大的身影還在沉睡，你還沒準備好。', intro: '食人魔醒了過來！', victory: '洞窟安靜了下來。' },
  },
};

GameSpecSchema.parse(spec); // the schema is the contract; a silently-ignored field is a spec bug

const session = await openProject(project, { requireEditorClosed: false });
const report = await generateGame(session, spec, { battleTrials: 300 });

const data = {};
for (const name of session.listFiles()) data[name] = session.readFile(name);

// Per-tile, per-direction passability, computed here with mapgen's own
// `checkPassage` rather than re-derived in the page. It is a port of
// `Game_Map.checkPassage` (layer order, the ★ abstain rule, tile id 0's trap),
// and a second copy written against a screenshot of it would be the one thing
// in the demo that could disagree with the toolchain it is demonstrating.
// One byte per tile: bit 0 down, 1 left, 2 right, 3 up — MZ's own bit order.
const tilesets = data['Tilesets.json'];
const pass = {};
for (const area of report.build?.areas ?? []) {
  const map = data[`Map${String(area.mapId).padStart(3, '0')}.json`];
  const flags = tilesets[map.tilesetId].flags;
  const grid = new Array(map.width * map.height);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      grid[y * map.width + x] =
        (checkPassage(map, flags, x, y, 'down') ? 1 : 0) |
        (checkPassage(map, flags, x, y, 'left') ? 2 : 0) |
        (checkPassage(map, flags, x, y, 'right') ? 4 : 0) |
        (checkPassage(map, flags, x, y, 'up') ? 8 : 0);
    }
  }
  pass[area.mapId] = grid;
  // The claim `compose_map` makes by construction, re-checked against the flags
  // the page will actually walk on: one walkable region, no sealed-off room.
  const reach = analyzeReachability(session, area.mapId);
  area.regionSizes = reach.regionSizes;
}

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      spec,
      data,
      pass,
      report: {
        ok: report.ok,
        summary: report.summary,
        issues: report.issues,
        findings: report.findings,
        battles: report.battles,
        scenarios: report.scenarios.map((s) => ({
          name: s.name,
          pass: s.pass,
          steps: s.steps.length,
          checks: s.steps.reduce((n, step) => n + (step.checks?.length ?? 0), 0),
          failures: s.failures,
          durationMs: s.durationMs,
          battles: s.battles,
          messages: s.messages,
          coverage: s.coverage,
          unmodeled: s.unmodeled,
        })),
        suite: report.suite,
        build: report.build && {
          party: report.build.party,
          areas: report.build.areas.map((a) => ({ key: a.key, name: a.name, mapId: a.mapId, start: a.start, regionSizes: a.regionSizes })),
          quests: report.build.quests.map((q) => ({ key: q.key, title: q.title, switches: q.switches ?? null })),
          finale: { name: report.build.finale.name, mapId: report.build.finale.mapId, troopId: report.build.finale.troopId },
        },
      },
    },
    null,
    0
  )
);

console.log(report.summary);
console.log('ok =', report.ok);
console.log('battles:', report.battles.map((b) => `${b.what} ${(b.winRate * 100).toFixed(0)}%`).join(', '));
console.log('scenarios:', report.scenarios.map((s) => `${s.name}:${s.pass ? 'pass' : 'FAIL'}`).join(', '));
console.log('findings:', report.findings.length);
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
