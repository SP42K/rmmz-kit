import type { ProjectSession, SystemData, EventConditions } from '@rmmz-kit/core';
import { RefIndex } from '@rmmz-kit/core';
import type { Finding } from '../types.js';
import { forEachMapEvent, forEachCommandList, tryDecompile, walkNodes } from '../walk.js';

/** Semantic / graph checks (plan §4.4 "語意/圖分析" and the cleanup-suggestion part of "資源"). Each is a static heuristic, not a game-state simulator — see each function's doc for what it deliberately doesn't try to catch. */
export function checkSemantics(session: ProjectSession): Finding[] {
  const findings: Finding[] = [];
  checkDeadPages(session, findings);
  checkSelfSwitchNeverReset(session, findings);
  checkNamespaceCollisions(session, findings);
  checkNegativeResources(session, findings);
  checkUnusedFlags(session, findings);
  return findings;
}

type CondKey = string;

function conditionKeys(c: EventConditions): Set<CondKey> {
  const keys = new Set<CondKey>();
  if (c.switch1Valid) keys.add(`switch:${c.switch1Id}`);
  if (c.switch2Valid) keys.add(`switch:${c.switch2Id}`);
  if (c.selfSwitchValid) keys.add(`selfSwitch:${c.selfSwitchCh}`);
  if (c.itemValid) keys.add(`item:${c.itemId}`);
  if (c.actorValid) keys.add(`actor:${c.actorId}`);
  // The threshold is part of the key. Dropping it would *weaken* the later
  // page's key and make "var >= 10" look implied by "var >= 5", reporting a
  // perfectly live page as dead. Requiring an exact match instead is the
  // conservative direction: a genuinely shadowed pair with diverging
  // thresholds (page 2 "var >= 3" over page 1 "var >= 5") goes unreported,
  // which needs a constraint solver to do properly.
  if (c.variableValid) keys.add(`variable:${c.variableId}>=${c.variableValue}`);
  return keys;
}

function isSubset(sub: Set<CondKey>, sup: Set<CondKey>): boolean {
  for (const k of sub) if (!sup.has(k)) return false;
  return true;
}

/**
 * MZ picks an event's active page by scanning from the LAST page to the
 * first and using the first match — i.e. a later page beats an earlier one.
 * A page is dead if some later page's condition set is a subset of its own:
 * whenever the dead page's conditions hold, the later (higher-priority) page's
 * weaker conditions necessarily hold too, so it always wins first.
 */
function checkDeadPages(session: ProjectSession, findings: Finding[]): void {
  forEachMapEvent(session, (_mapId, file, event) => {
    const keys = event.pages.map((p) => conditionKeys(p.conditions));
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (isSubset(keys[j], keys[i])) {
          findings.push({
            rule: 'semantics/dead-event-page',
            severity: 'error',
            message: `Page ${i + 1} can never trigger: page ${j + 1}'s conditions are always satisfied whenever page ${i + 1}'s are, and MZ matches pages from last to first`,
            file,
            path: `event ${event.id} (${event.name}) > page ${i + 1}`,
          });
          break;
        }
      }
    }
  });
}

/** Self switches are per-(map, event, A-D), shared by every page of that one event. If some page turns one on and no page in the same event ever turns it back off, whatever page that switch gates can never be shown again once left. */
function checkSelfSwitchNeverReset(session: ProjectSession, findings: Finding[]): void {
  const state = new Map<string, { on: boolean; off: boolean; file: string; path: string; eventName: string }>();
  forEachCommandList(session, (ctx) => {
    if (ctx.kind !== 'mapEventPage') return;
    const nodes = tryDecompile(ctx.list);
    if (!nodes) return;
    walkNodes(nodes, (node) => {
      if (node.kind !== 'setSelfSwitch') return;
      const key = `${ctx.file}:${ctx.eventId}:${node.ch}`;
      const entry = state.get(key) ?? { on: false, off: false, file: ctx.file, path: ctx.path, eventName: ctx.eventName! };
      if (node.value) entry.on = true;
      else entry.off = true;
      state.set(key, entry);
    });
  });
  for (const entry of state.values()) {
    if (entry.on && !entry.off) {
      findings.push({
        rule: 'semantics/self-switch-never-reset',
        severity: 'warning',
        message: `A self switch is turned ON somewhere in "${entry.eventName}" but never turned back OFF anywhere in the same event`,
        file: entry.file,
        path: entry.path,
      });
    }
  }
}

function namespaceOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const idx = name.lastIndexOf('.');
  return idx === -1 ? undefined : name.slice(0, idx);
}

/**
 * Heuristic for plan §4.4's "同一 switch 被兩條任務線寫入": a page gated on a
 * named-namespace switch (e.g. "quest.herb.0") that writes a switch belonging
 * to a *different* namespace ("quest.flower.1") is flagged — commonly a
 * copy-pasted event with the wrong switch id. Writes within the same
 * namespace, and writes to unnamed switches, are not flagged.
 */
function checkNamespaceCollisions(session: ProjectSession, findings: Finding[]): void {
  if (!session.listFiles().includes('System.json')) return;
  const switchNames = session.readFile<SystemData>('System.json').switches ?? [];

  forEachCommandList(session, (ctx) => {
    if (ctx.kind !== 'mapEventPage' || !ctx.conditions) return;
    const gateIds = [
      ctx.conditions.switch1Valid ? ctx.conditions.switch1Id : undefined,
      ctx.conditions.switch2Valid ? ctx.conditions.switch2Id : undefined,
    ].filter((id): id is number => id !== undefined);
    const gateNamespaces = new Set(gateIds.map((id) => namespaceOf(switchNames[id])).filter((ns): ns is string => !!ns));
    if (gateNamespaces.size === 0) return;

    const nodes = tryDecompile(ctx.list);
    if (!nodes) return;
    walkNodes(nodes, (node) => {
      if (node.kind !== 'setSwitch') return;
      for (let id = node.from; id <= node.to; id++) {
        const ns = namespaceOf(switchNames[id]);
        if (ns && !gateNamespaces.has(ns)) {
          findings.push({
            rule: 'semantics/cross-namespace-switch-write',
            severity: 'warning',
            message: `Page gated on namespace "${[...gateNamespaces].join(', ')}" writes switch ${id} ("${switchNames[id]}"), which belongs to a different namespace "${ns}"`,
            file: ctx.file,
            path: ctx.path,
          });
        }
      }
    });
  });
}

/** Heuristic for plan §4.4's "玩家可能取得負數金錢/物品": flags a gold/item decrease with no enclosing "Gold >=" / "has item" Conditional Branch. Guard tracking is scope-accurate (walkNodes threads it through `if.then` only) but not value-accurate — it can't tell if the checked threshold actually covers the amount removed. */
function checkNegativeResources(session: ProjectSession, findings: Finding[]): void {
  forEachCommandList(session, (ctx) => {
    const nodes = tryDecompile(ctx.list);
    if (!nodes) return;
    walkNodes(nodes, (node, guards) => {
      if (node.kind !== 'raw') return;
      if (node.code === 125) {
        const [operation] = node.parameters as number[];
        if (operation === 1 && !guards.gold) {
          findings.push({
            rule: 'semantics/possible-negative-gold',
            severity: 'warning',
            message: 'Change Gold decreases gold with no enclosing "Gold >=" check',
            file: ctx.file,
            path: ctx.path,
          });
        }
      }
      if (node.code === 126) {
        const [itemId, operation] = node.parameters as number[];
        if (operation === 1 && !guards.items.has(itemId)) {
          findings.push({
            rule: 'semantics/possible-negative-item',
            severity: 'warning',
            message: `Change Items decreases item ${itemId} with no enclosing "has item" check`,
            file: ctx.file,
            path: ctx.path,
          });
        }
      }
    });
  });
}

/** Cleanup suggestion (plan §4.4 "資源"): named in System.json but never read or written by any event. */
function checkUnusedFlags(session: ProjectSession, findings: Finding[]): void {
  if (!session.listFiles().includes('System.json')) return;
  const system = session.readFile<SystemData>('System.json');
  const referenced = new Set(RefIndex.build(session).entries().map((e) => `${e.kind}:${e.id}`));

  (system.switches ?? []).forEach((name, id) => {
    if (id > 0 && name && !referenced.has(`switch:${id}`)) {
      findings.push({
        rule: 'semantics/unused-switch',
        severity: 'info',
        message: `Switch ${id} ("${name}") is named but never referenced by any event`,
        file: 'System.json',
        path: `switches[${id}]`,
      });
    }
  });
  (system.variables ?? []).forEach((name, id) => {
    if (id > 0 && name && !referenced.has(`variable:${id}`)) {
      findings.push({
        rule: 'semantics/unused-variable',
        severity: 'info',
        message: `Variable ${id} ("${name}") is named but never referenced by any event`,
        file: 'System.json',
        path: `variables[${id}]`,
      });
    }
  });
}
