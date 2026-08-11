import { ProjectSession } from './session.js';
import { CommonEvent, EventCommand, EventPage, MapData } from './types/mz.js';

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
 */
export class RefIndex {
  private readonly byRef = new Map<string, RefLocation[]>();

  static build(session: ProjectSession): RefIndex {
    const index = new RefIndex();
    for (const file of session.listFiles()) {
      if (/^Map\d+\.json$/.test(file)) {
        index.scanMap(session.readFile<MapData>(file), file);
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
        this.scanPageConditions(page, file, `event ${event.id} > page ${pageIndex + 1}`);
        this.scanCommands(page.list, file, `event ${event.id} > page ${pageIndex + 1}`);
      });
    }
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
