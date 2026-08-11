import { ProjectSession } from './session.js';
import { CommonEvent, EventCommand, EventPage, MapData, MoveRoute, Troop } from './types/mz.js';

export type RefKind = 'switch' | 'variable' | 'item' | 'actor' | 'map' | 'commonEvent';

export interface RefLocation {
  kind: RefKind;
  id: number;
  file: string;
  path: string;
}

/**
 * Reverse index ("what refers to switch 7 / item 3 / Map012") built by
 * scanning event page conditions and a small, explicitly-listed subset of
 * event command codes. Full event-command parameter semantics is the L2
 * compiler's job (§4.3 of the plan, ~35 command codes); this only knows the
 * handful needed for reference tracking and grows as L2's dictionary does.
 *
 * Every place a reference can hide has to be scanned, though, or the index
 * answers "nothing refers to this" about something that breaks when deleted —
 * which is the one answer it exists to give. So: map events, common events
 * (including the autorun/parallel trigger switch), troop battle-event pages,
 * and the nested move-route lists inside both.
 */
export class RefIndex {
  private readonly byRef = new Map<string, RefLocation[]>();

  static build(session: ProjectSession): RefIndex {
    const index = new RefIndex();
    for (const file of session.listFiles()) {
      if (/^Map\d+\.json$/.test(file)) {
        index.scanMap(session.readFile<MapData>(file), file);
      } else if (file === 'Troops.json') {
        index.scanTroops(session.readFile<Array<Troop | null>>(file), file);
      } else if (file === 'CommonEvents.json') {
        for (const event of session.readFile<Array<CommonEvent | null>>(file)) {
          if (!event) continue;
          const path = `commonEvent ${event.id}`;
          // trigger 0 = none; autorun/parallel commons are gated on switchId,
          // which is a switch reference the command list never mentions.
          if (event.trigger !== 0 && event.switchId) {
            index.add({ kind: 'switch', id: event.switchId, file, path: `${path} > trigger switch` });
          }
          index.scanCommands(event.list, file, path);
        }
      }
    }
    return index;
  }

  referencesTo(kind: RefKind, id: number): RefLocation[] {
    return this.byRef.get(key(kind, id)) ?? [];
  }

  /** Every (kind, id) actually referenced somewhere, with its locations. Used by L4 to check each id against its owning table without re-scanning commands itself. */
  entries(): Array<{ kind: RefKind; id: number; locations: RefLocation[] }> {
    return [...this.byRef.entries()].map(([k, locations]) => {
      const [kind, idStr] = k.split(':') as [RefKind, string];
      return { kind, id: Number(idStr), locations };
    });
  }

  private add(loc: RefLocation): void {
    const k = key(loc.kind, loc.id);
    const list = this.byRef.get(k);
    if (list) list.push(loc);
    else this.byRef.set(k, [loc]);
  }

  private scanMap(map: MapData, file: string): void {
    for (const event of map.events) {
      if (!event) continue;
      event.pages.forEach((page, pageIndex) => {
        const path = `event ${event.id} > page ${pageIndex + 1}`;
        this.scanPageConditions(page, file, path);
        // Autonomous movement (moveType 3 = Custom) is a move route too, and
        // can flip switches without the command list ever mentioning them.
        this.scanMoveRoute(page.moveRoute, file, `${path} > autonomous move route`);
        this.scanCommands(page.list, file, path);
      });
    }
  }

  /**
   * Troop battle-event pages are map-event pages living in another file: a
   * `switchId` page condition plus an ordinary event command list. Skipping
   * them made a switch that is only ever set from battle read as unreferenced.
   */
  private scanTroops(troops: Array<Troop | null>, file: string): void {
    for (const troop of troops) {
      if (!troop) continue;
      troop.pages.forEach((page, pageIndex) => {
        const path = `troop ${troop.id} > page ${pageIndex + 1}`;
        if (page.conditions.switchValid) {
          this.add({ kind: 'switch', id: page.conditions.switchId, file, path: `${path} > condition.switch` });
        }
        this.scanCommands(page.list, file, path);
      });
    }
  }

  /**
   * A move route's `list` uses movement command codes (Game_Character.ROUTE_*),
   * a different numbering space from event commands — hence a separate scanner
   * rather than more cases in scanCommands. Only 27/28 (Switch ON/OFF) carry a
   * reference; script steps (45) are left unparsed, same as event-command
   * scripts everywhere else in this file.
   */
  private scanMoveRoute(route: MoveRoute | undefined, file: string, path: string): void {
    if (!route?.list) return;
    route.list.forEach((cmd, i) => {
      if (cmd.code !== 27 && cmd.code !== 28) return;
      this.add({ kind: 'switch', id: cmd.parameters[0], file, path: `${path} > step ${i} (code ${cmd.code})` });
    });
  }

  private scanPageConditions(page: EventPage, file: string, path: string): void {
    const c = page.conditions;
    if (c.switch1Valid) this.add({ kind: 'switch', id: c.switch1Id, file, path: `${path} > condition.switch1` });
    if (c.switch2Valid) this.add({ kind: 'switch', id: c.switch2Id, file, path: `${path} > condition.switch2` });
    if (c.variableValid) this.add({ kind: 'variable', id: c.variableId, file, path: `${path} > condition.variable` });
    if (c.itemValid) this.add({ kind: 'item', id: c.itemId, file, path: `${path} > condition.item` });
    if (c.actorValid) this.add({ kind: 'actor', id: c.actorId, file, path: `${path} > condition.actor` });
  }

  private scanCommands(list: EventCommand[], file: string, path: string): void {
    list.forEach((cmd, i) => {
      const at = `${path} > command ${i} (code ${cmd.code})`;
      switch (cmd.code) {
        case 121: {
          // Control Switches: [startId, endId, value]
          const [start, end] = cmd.parameters as [number, number, number];
          for (let id = start; id <= end; id++) this.add({ kind: 'switch', id, file, path: at });
          break;
        }
        case 117:
          this.add({ kind: 'commonEvent', id: cmd.parameters[0], file, path: at });
          break;
        case 126:
          // Change Items: [itemId, ...]
          this.add({ kind: 'item', id: cmd.parameters[0], file, path: at });
          break;
        case 122: {
          // Control Variables: [startId, endId, operationType, operand, ...].
          // operand 1 ("variable") makes parameters[4] a second variable read.
          const [start, end, , operand] = cmd.parameters as number[];
          for (let id = start; id <= end; id++) this.add({ kind: 'variable', id, file, path: at });
          if (operand === 1) this.add({ kind: 'variable', id: cmd.parameters[4], file, path: at });
          break;
        }
        case 111: {
          // Conditional Branch: [type, ...]; type 0 = switch, 1 = variable, 8 = item.
          // 411 is *not* a second branch code — it's "Else" and carries no
          // parameters at all, so it has nothing to index.
          const [type] = cmd.parameters as [number, ...number[]];
          if (type === 0) this.add({ kind: 'switch', id: cmd.parameters[1], file, path: at });
          if (type === 1) {
            this.add({ kind: 'variable', id: cmd.parameters[1], file, path: at });
            // parameters[2] 1 = compare against another variable, held in [3].
            if (cmd.parameters[2] === 1) this.add({ kind: 'variable', id: cmd.parameters[3], file, path: at });
          }
          if (type === 8) this.add({ kind: 'item', id: cmd.parameters[1], file, path: at });
          break;
        }
        case 205: {
          // Set Movement Route: [characterId, route]. The route's own steps can
          // turn switches on/off, so they have to be scanned. Code 505 re-emits
          // each of those steps inline in *this* list; it deliberately has no
          // case here, so nothing gets counted twice.
          this.scanMoveRoute(cmd.parameters[1] as MoveRoute | undefined, file, at);
          break;
        }
        case 201: {
          // Transfer Player: [designation, mapId, x, y, dir, fade]; designation 0 = direct mapId
          const [designation, mapId] = cmd.parameters as [number, number, ...number[]];
          if (designation === 0) this.add({ kind: 'map', id: mapId, file, path: at });
          break;
        }
      }
    });
  }
}

function key(kind: RefKind, id: number): string {
  return `${kind}:${id}`;
}
