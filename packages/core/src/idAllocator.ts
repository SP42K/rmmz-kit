import { ProjectSession } from './session.js';
import { NamespaceRegistry, type NamespaceField } from './namespaces.js';
import { SystemData } from './types/mz.js';

export interface NamespaceAllocation {
  namespace: string;
  /** member name -> allocated id. Count-form members are named "0".."n-1". */
  switches: Record<string, number>;
  variables: Record<string, number>;
}

/**
 * Switch/variable IDs and names live in System.json as parallel string arrays
 * (index = ID, index 0 unused). "Namespace" per the plan (§4.1/M2) means a
 * contiguous block named after its owner (e.g. `quest.herb.started`) so a
 * human skimming the editor's switch list can tell which flags belong to
 * which quest.
 *
 * Occupancy is decided by the NamespaceRegistry (its own data file), not by
 * the System.json names — those are only a mirror for the editor, and
 * `update_system` can replace them whole (M6.5 gap #2). A slot is free when
 * it is unnamed *and* unregistered; hand-named switches an editor user made
 * still count as taken.
 *
 * Caveat: the editor happily lets a project use switch 20 in events without
 * ever naming it, so this can still hand out an ID that is live game logic.
 * Detecting that collision is L4's job per the plan (§ "同一 switch 被兩條
 * 任務線寫入"), which is why the allocator does not consult RefIndex itself —
 * see the risk note in the plan before "fixing" it by wiring the two together.
 */
export class IdAllocator {
  private readonly registry: NamespaceRegistry;

  constructor(private readonly session: ProjectSession) {
    this.registry = new NamespaceRegistry(session);
  }

  /** Counts may be a number (members named "0".."n-1") or a list of member names (`["started", "done"]`). */
  allocNamespace(
    namespace: string,
    counts: { switches?: number | string[]; variables?: number | string[] }
  ): NamespaceAllocation {
    return {
      namespace,
      switches: this.allocNamed('switches', namespace, toMembers(counts.switches)),
      variables: this.allocNamed('variables', namespace, toMembers(counts.variables)),
    };
  }

  allocSwitches(namespace: string, count: number): number[] {
    return Object.values(this.allocNamed('switches', namespace, toMembers(count)));
  }

  allocVariables(namespace: string, count: number): number[] {
    return Object.values(this.allocNamed('variables', namespace, toMembers(count)));
  }

  releaseSwitches(ids: number[]): void {
    this.releaseNamed('switches', ids);
  }

  releaseVariables(ids: number[]): void {
    this.releaseNamed('variables', ids);
  }

  /** First free (null) slot in a `[null, {id: 1, ...}, ...]` database table, or the next id past the end. */
  allocEntityId(file: string): number {
    const arr = this.session.readFile<unknown[]>(file);
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] == null) return i;
    }
    return arr.length;
  }

  private allocNamed(field: NamespaceField, namespace: string, members: string[]): Record<string, number> {
    // Guard before findContiguousFree: it scans for a run of `count` free slots
    // and would spin forever looking for a run of length <= 0. Also keeps a
    // no-op allocation from marking System.json dirty.
    if (members.length === 0) return {};
    for (const member of members) {
      // '.' would make `namespace.member` ambiguous to resolve; a duplicate
      // would silently collapse two ids into one registry entry.
      if (!member || member.includes('.')) {
        throw new Error(`Invalid member name ${JSON.stringify(member)}: must be non-empty and contain no '.'`);
      }
    }
    if (new Set(members).size !== members.length) {
      throw new Error(`Duplicate member names in ${JSON.stringify(members)}`);
    }
    // Re-allocating a member the namespace already has would overwrite its
    // registry entry (record() Object.assigns), leaving the *first* id named in
    // System.json but unregistered — i.e. free again the moment update_system
    // replaces the names array, which is exactly the M6.5 gap #2 this registry
    // exists to close. Refuse, and name the ids the caller should reuse.
    const existing = this.registry.list()[namespace]?.[field] ?? {};
    const taken = members.filter((member) => member in existing);
    if (taken.length > 0) {
      throw new Error(
        `Namespace ${JSON.stringify(namespace)} already owns ${field} ${taken.map((m) => `${m}=${existing[m]}`).join(', ')}. ` +
          `Re-allocating would orphan those ids — use them as they are, or release them first.`
      );
    }

    const occupied = this.registry.allocatedIds(field);
    const allocated: Record<string, number> = {};
    this.session.updateFile<SystemData>('System.json', (data) => {
      const names = data[field] ?? (data[field] = []);
      const start = findContiguousFree(names, occupied, members.length);
      members.forEach((member, i) => {
        const id = start + i;
        allocated[member] = id;
        while (names.length <= id) names.push('');
        names[id] = `${namespace}.${member}`;
      });
    });
    this.registry.record(namespace, field, allocated);
    return allocated;
  }

  private releaseNamed(field: NamespaceField, ids: number[]): void {
    this.session.updateFile<SystemData>('System.json', (data) => {
      const names = data[field] ?? [];
      for (const id of ids) {
        if (id > 0 && id < names.length) names[id] = '';
      }
    });
    this.registry.release(field, ids);
  }
}

function toMembers(counts: number | string[] | undefined): string[] {
  if (Array.isArray(counts)) return counts;
  if (!counts || counts <= 0) return [];
  return Array.from({ length: counts }, (_, i) => String(i));
}

function findContiguousFree(names: string[], occupied: Set<number>, count: number): number {
  let runStart = 1;
  let runLen = 0;
  for (let i = 1; ; i++) {
    const free = (i >= names.length || !names[i]) && !occupied.has(i);
    if (free) {
      if (runLen === 0) runStart = i;
      runLen++;
      if (runLen === count) return runStart;
    } else {
      runLen = 0;
    }
  }
}
