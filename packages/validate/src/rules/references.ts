import path from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Actor, Class, Enemy, ProjectSession, RefKind, SystemData, MapData } from '@rmmz-kit/core';
import { RefIndex, mapFileName } from '@rmmz-kit/core';
import type { Finding } from '../types.js';
import type { ListContext } from '../walk.js';
import { forEachCommandList, tryDecompile, walkNodes } from '../walk.js';

/**
 * Reference integrity (plan §4.4 "參照完整性"). The Tier 1 subset rides
 * RefIndex; the weapon/armor/skill/state/troop ids §8.1-2 owed are read off
 * the decompiled typed nodes M7.5 made available (checkTypedCommandIds), and
 * the class/skill ids that live in database rows rather than command lists
 * are checked directly (checkDatabaseIds).
 */
export async function checkReferences(session: ProjectSession): Promise<Finding[]> {
  const findings: Finding[] = [];
  checkDanglingIds(session, findings);
  checkTypedCommandIds(session, findings);
  checkDatabaseIds(session, findings);
  checkTransferBounds(session, findings);
  await checkAssets(session, findings);
  return findings;
}

function idSet(session: ProjectSession, file: string): Set<number> {
  if (!session.listFiles().includes(file)) return new Set();
  const ids = new Set<number>();
  for (const entry of session.readFile<Array<{ id: number } | null>>(file)) {
    if (entry) ids.add(entry.id);
  }
  return ids;
}

/**
 * Switches/variables aren't a bounded table in MZ — any numeric id "works" at
 * runtime, it just shows blank in the editor. So an id with no name in
 * System.json isn't a broken reference, only a sign it was never allocated
 * (see idAllocator.ts's own caveat on this) — reported as a warning, not the
 * error a truly dangling item/actor/map/commonEvent id gets.
 */
function checkDanglingIds(session: ProjectSession, findings: Finding[]): void {
  const refIndex = RefIndex.build(session);
  const tables: Partial<Record<RefKind, Set<number>>> = {
    item: idSet(session, 'Items.json'),
    actor: idSet(session, 'Actors.json'),
    commonEvent: idSet(session, 'CommonEvents.json'),
    map: idSet(session, 'MapInfos.json'),
  };
  const system = session.listFiles().includes('System.json') ? session.readFile<SystemData>('System.json') : undefined;
  const namesByKind: Partial<Record<RefKind, string[]>> = {
    switch: system?.switches ?? [],
    variable: system?.variables ?? [],
  };

  for (const { kind, id, locations } of refIndex.entries()) {
    const names = namesByKind[kind];
    if (names) {
      if (!names[id]) {
        for (const loc of locations) {
          findings.push({
            rule: `references/unnamed-${kind}`,
            severity: 'warning',
            message: `${kind} ${id} is referenced but has no name in System.json (never allocated?)`,
            file: loc.file,
            path: loc.path,
          });
        }
      }
      continue;
    }
    const table = tables[kind];
    if (table && !table.has(id)) {
      for (const loc of locations) {
        findings.push({
          rule: `references/dangling-${kind}`,
          severity: 'error',
          message: `${kind} ${id} is referenced but does not exist`,
          file: loc.file,
          path: loc.path,
        });
      }
    }
  }
}

/**
 * The §8.1-2 debt: dangling weapon/armor/skill/state/troop/actor/animation ids
 * in command lists. RefIndex only knows Tier 1 codes; these ids live in Tier 2 nodes, so
 * they are read off the decompiled tree instead of extending RefIndex's code
 * dictionary a second time. A table whose file is absent is skipped rather
 * than treated as empty — same "can't say anything" stance checkAssets takes,
 * or a partial project would report every reference as dangling.
 *
 * actorId 0 with actorType 0 is MZ's "entire party" (iterateActorId), not a
 * reference; actorType 1 makes actorId a variable id, which is the unnamed-
 * variable warning's territory, not this rule's.
 */
function checkTypedCommandIds(session: ProjectSession, findings: Finding[]): void {
  const files = new Set(session.listFiles());
  const tables = new Map<string, Set<number>>();
  for (const [kind, file] of [
    ['item', 'Items.json'],
    ['weapon', 'Weapons.json'],
    ['armor', 'Armors.json'],
    ['skill', 'Skills.json'],
    ['state', 'States.json'],
    ['troop', 'Troops.json'],
    ['actor', 'Actors.json'],
    ['animation', 'Animations.json'],
  ] as const) {
    if (files.has(file)) tables.set(kind, idSet(session, file));
  }

  function report(kind: string, id: number, ctx: ListContext): void {
    const table = tables.get(kind);
    if (!table || table.has(id)) return;
    findings.push({
      rule: `references/dangling-${kind}`,
      severity: 'error',
      message: `${kind} ${id} is referenced but does not exist`,
      file: ctx.file,
      path: ctx.path,
    });
  }
  function reportActor(node: { actorType: number; actorId: number }, ctx: ListContext): void {
    if (node.actorType === 0 && node.actorId > 0) report('actor', node.actorId, ctx);
  }

  forEachCommandList(session, (ctx) => {
    const nodes = tryDecompile(ctx.list);
    if (!nodes) return;
    walkNodes(nodes, (node) => {
      switch (node.kind) {
        case 'gainWeapon':
          report('weapon', node.weaponId, ctx);
          break;
        case 'gainArmor':
          report('armor', node.armorId, ctx);
          break;
        case 'changeParty':
          report('actor', node.actorId, ctx);
          break;
        case 'changeSkill':
          report('skill', node.skillId, ctx);
          reportActor(node, ctx);
          break;
        case 'changeState':
          report('state', node.stateId, ctx);
          reportActor(node, ctx);
          break;
        case 'changeHp':
        case 'changeMp':
        case 'recoverAll':
        case 'changeExp':
        case 'changeLevel':
        case 'changeParameter':
          reportActor(node, ctx);
          break;
        case 'showAnimation':
          // 0 is the editor's "None", not a reference. A dangling one is
          // `Sprite_Animation` loading `undefined.effectName` — a crash on the
          // frame the event plays, which is the same class of bug as every
          // other id here and was the one Tier 2 node id §8.1-2 left out.
          if (node.animationId > 0) report('animation', node.animationId, ctx);
          break;
        case 'battle':
          // designation 1 reads the troop id from a variable, 2 from the map's
          // encounter list — only the direct form names a troop to check.
          if (node.designation === 0) report('troop', node.troopId, ctx);
          break;
        case 'shop':
          for (const good of node.goods) {
            report((['item', 'weapon', 'armor'] as const)[good.type] ?? 'item', good.id, ctx);
          }
          break;
      }
    });
  });
}

/**
 * The rest of §8.1-2: class and skill ids that never pass through a command
 * list because they live in database rows — an actor's classId, a class's
 * learnings, an enemy's action skills. Same absent-file stance as above.
 */
function checkDatabaseIds(session: ProjectSession, findings: Finding[]): void {
  const files = new Set(session.listFiles());
  function report(rule: string, message: string, file: string, at: string): void {
    findings.push({ rule, severity: 'error', message, file, path: at });
  }

  if (files.has('Actors.json') && files.has('Classes.json')) {
    const classes = idSet(session, 'Classes.json');
    for (const actor of session.readFile<Array<Actor | null>>('Actors.json')) {
      if (actor && !classes.has(actor.classId)) {
        report('references/dangling-class', `class ${actor.classId} is referenced but does not exist`, 'Actors.json', `actor ${actor.id} (${actor.name}) > classId`);
      }
    }
  }
  if (files.has('Classes.json') && files.has('Skills.json')) {
    const skills = idSet(session, 'Skills.json');
    for (const klass of session.readFile<Array<Class | null>>('Classes.json')) {
      if (!klass) continue;
      klass.learnings.forEach((learning, i) => {
        if (!skills.has(learning.skillId)) {
          report('references/dangling-skill', `skill ${learning.skillId} is referenced but does not exist`, 'Classes.json', `class ${klass.id} (${klass.name}) > learnings[${i}]`);
        }
      });
    }
  }
  if (files.has('Enemies.json') && files.has('Skills.json')) {
    const skills = idSet(session, 'Skills.json');
    for (const enemy of session.readFile<Array<Enemy | null>>('Enemies.json')) {
      if (!enemy) continue;
      enemy.actions.forEach((action, i) => {
        if (!skills.has(action.skillId)) {
          report('references/dangling-skill', `skill ${action.skillId} is referenced but does not exist`, 'Enemies.json', `enemy ${enemy.id} (${enemy.name}) > actions[${i}]`);
        }
      });
    }
  }
}

function checkTransferBounds(session: ProjectSession, findings: Finding[]): void {  forEachCommandList(session, (ctx) => {
    const nodes = tryDecompile(ctx.list);
    if (!nodes) return;
    walkNodes(nodes, (node) => {
      if (node.kind !== 'transfer') return;
      const file = mapFileName(node.mapId);
      // A nonexistent target map is already reported as references/dangling-map.
      if (!session.listFiles().includes(file)) return;
      const target = session.readFile<MapData>(file);
      if (node.x < 0 || node.x >= target.width || node.y < 0 || node.y >= target.height) {
        findings.push({
          rule: 'references/transfer-out-of-bounds',
          severity: 'error',
          message: `Transfer target (${node.x}, ${node.y}) is outside Map${node.mapId} (${target.width}x${target.height})`,
          file: ctx.file,
          path: ctx.path,
        });
      }
    });
  });
}

/**
 * Face / character / SE filenames are stored without extension. A missing
 * asset directory means the check can't say anything (not that every
 * reference in it is broken), so it's silently skipped rather than flagging
 * every reference — real signal only comes once the directory exists.
 */
async function checkAssets(session: ProjectSession, findings: Finding[]): Promise<void> {
  // Caches the *promise*, not the resolved value: every check() below runs
  // concurrently, so caching after the await would let a project with N face
  // references fire N readdir calls on the same directory before the first
  // one lands. Extensions are stripped once per directory, not once per
  // reference, for the same reason.
  const dirCache = new Map<string, Promise<string[] | null>>();
  // Assets imported in this session are staged, not on disk, until commit()
  // writes them alongside the rows referencing them (M7.6). Ignoring them would
  // make validate report every fresh import as a broken reference — and since
  // an agent is meant to run validate *before* deciding to commit, that is the
  // one moment the warning is guaranteed wrong.
  const staged = session.rawWriteFiles();
  function listDir(rel: string): Promise<string[] | null> {
    let pending = dirCache.get(rel);
    if (!pending) {
      const pendingNames = staged.filter((file) => file.startsWith(`${rel}/`)).map((file) => file.slice(rel.length + 1));
      pending = readdir(path.join(session.rootPath, rel))
        .then((entries) => [...entries, ...pendingNames])
        .catch(() => (pendingNames.length > 0 ? pendingNames : null))
        .then((entries) => entries && entries.map((f) => f.replace(/\.[^./]+$/, '')));
      dirCache.set(rel, pending);
    }
    return pending;
  }

  async function check(rel: string, name: string | undefined, ctx: { file: string; path: string }): Promise<void> {
    if (!name) return;
    const stripped = await listDir(rel);
    if (!stripped) return;
    if (stripped.includes(name)) return;
    const caseInsensitiveMatch = stripped.find((f) => f.toLowerCase() === name.toLowerCase());
    findings.push({
      rule: caseInsensitiveMatch ? 'references/asset-case-mismatch' : 'references/asset-missing',
      severity: caseInsensitiveMatch ? 'warning' : 'error',
      message: caseInsensitiveMatch
        ? `${rel}/${name} differs only in case from existing file "${caseInsensitiveMatch}" — breaks on case-sensitive filesystems`
        : `${rel}/${name} does not exist`,
      file: ctx.file,
      path: ctx.path,
    });
  }

  const tasks: Promise<void>[] = [];
  forEachCommandList(session, (ctx: ListContext) => {
    if (ctx.kind === 'mapEventPage' && ctx.image?.characterName) {
      tasks.push(check('img/characters', ctx.image.characterName, ctx));
    }
    const nodes = tryDecompile(ctx.list);
    if (!nodes) return;
    walkNodes(nodes, (node) => {
      if (node.kind === 'text') tasks.push(check('img/faces', node.face, ctx));
      if (node.kind === 'playSe') tasks.push(check('audio/se', node.name, ctx));
    });
  });
  await Promise.all(tasks);
}
