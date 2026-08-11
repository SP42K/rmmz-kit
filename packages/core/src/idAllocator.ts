import { ProjectSession } from './session.js';
import { SystemData } from './types/mz.js';

export interface NamespaceAllocation {
  namespace: string;
  switches: number[];
  variables: number[];
}

/**
 * Switch/variable IDs and names live in System.json as parallel string arrays
 * (index = ID, index 0 unused). "Namespace" per the plan (§4.1/M2) just means
 * naming a contiguous block after its owner (e.g. `quest.herb.0`) so a human
 * skimming the editor's switch list can tell which flags belong to which
 * quest — there's no separate registry to keep in sync.
 *
 * Caveat: "free" here means "unnamed". The editor happily lets a project use
 * switch 20 in events without ever naming it, so this can hand out an ID that
 * is already live game logic. Detecting that collision is L4's job per the
 * plan (§ "同一 switch 被兩條任務線寫入"), which is why the allocator does not
 * consult RefIndex itself — see the risk note in the plan before "fixing" it
 * by wiring the two together.
 */
export class IdAllocator {
  constructor(private readonly session: ProjectSession) {}

  allocNamespace(namespace: string, counts: { switches?: number; variables?: number }): NamespaceAllocation {
    return {
      namespace,
      switches: counts.switches ? this.allocSwitches(namespace, counts.switches) : [],
      variables: counts.variables ? this.allocVariables(namespace, counts.variables) : [],
    };
  }

  allocSwitches(namespace: string, count: number): number[] {
    return this.allocNamed('switches', namespace, count);
  }

  allocVariables(namespace: string, count: number): number[] {
    return this.allocNamed('variables', namespace, count);
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

  private allocNamed(field: 'switches' | 'variables', namespace: string, count: number): number[] {
    // Guard before findContiguousFree: it scans for a run of `count` free slots
    // and would spin forever looking for a run of length <= 0. Also keeps a
    // no-op allocation from marking System.json dirty.
    if (count <= 0) return [];

    let ids: number[] = [];
    this.session.updateFile<SystemData>('System.json', (data) => {
      const names = data[field] ?? (data[field] = []);
      const start = findContiguousFree(names, count);
      ids = Array.from({ length: count }, (_, i) => start + i);
      for (const id of ids) {
        while (names.length <= id) names.push('');
        names[id] = `${namespace}.${id - start}`;
      }
    });
    return ids;
  }

  private releaseNamed(field: 'switches' | 'variables', ids: number[]): void {
    this.session.updateFile<SystemData>('System.json', (data) => {
      const names = data[field] ?? [];
      for (const id of ids) {
        if (id > 0 && id < names.length) names[id] = '';
      }
    });
  }
}

function findContiguousFree(names: string[], count: number): number {
  let runStart = 1;
  let runLen = 0;
  for (let i = 1; ; i++) {
    const free = i >= names.length || !names[i];
    if (free) {
      if (runLen === 0) runStart = i;
      runLen++;
      if (runLen === count) return runStart;
    } else {
      runLen = 0;
    }
  }
}
