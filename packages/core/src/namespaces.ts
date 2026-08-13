import { ProjectSession } from './session.js';

/**
 * Lives under data/ so it rides the ProjectSession transaction (createFile/
 * updateFile/rollback/commit) like every other project fact — a registry kept
 * anywhere else would need its own staging, drift and rollback story. MZ's
 * loader reads a fixed file list and plugins routinely park their own JSON in
 * data/, so the editor ignores it; deploy excludes it from builds the way it
 * excludes Game.rmmzproject (dev metadata, not game content).
 */
export const NAMESPACES_FILE = 'RmmzKitNamespaces.json';

export type NamespaceField = 'switches' | 'variables';

export interface NamespacesData {
  /** namespace -> member -> allocated id. Member names never contain '.', so `ns.member` splits unambiguously at the last dot. */
  namespaces: Record<string, Record<NamespaceField, Record<string, number>>>;
}

/**
 * The allocator's own occupancy record (plan §8.1-1, closing M6.5 gap #2).
 * System.json's name arrays are still written as a human-readable mirror, but
 * they are no longer what decides "this id is taken": `update_system` replaces
 * those arrays whole, and before this registry existed that made every
 * allocated id look free again — the next allocate_namespace would hand out a
 * switch that live events were already writing.
 *
 * It is also the name→id model the DSL's `quest.herb.started` sugar resolves
 * against (§4.2), and the namespace model §4.4's quest-graph analysis needs.
 */
export class NamespaceRegistry {
  constructor(private readonly session: ProjectSession) {}

  private data(): NamespacesData | null {
    return this.session.listFiles().includes(NAMESPACES_FILE)
      ? this.session.readFile<NamespacesData>(NAMESPACES_FILE)
      : null;
  }

  record(namespace: string, field: NamespaceField, members: Record<string, number>): void {
    if (Object.keys(members).length === 0) return;
    if (!this.session.listFiles().includes(NAMESPACES_FILE)) {
      this.session.createFile(NAMESPACES_FILE, { namespaces: {} } satisfies NamespacesData);
    }
    this.session.updateFile<NamespacesData>(NAMESPACES_FILE, (data) => {
      // `?? {}` throughout this class, not just here: the file is checked into
      // the project's git and documented as human-readable dev metadata, so a
      // hand-edit (or a merge) that drops one of the two field keys is a thing
      // that happens — and it must not turn into an opaque
      // "Cannot convert undefined or null to object" from the allocator.
      data.namespaces ??= {};
      const ns = (data.namespaces[namespace] ??= { switches: {}, variables: {} });
      ns[field] ??= {};
      Object.assign(ns[field], members);
    });
  }

  release(field: NamespaceField, ids: number[]): void {
    if (ids.length === 0 || !this.session.listFiles().includes(NAMESPACES_FILE)) return;
    const drop = new Set(ids);
    this.session.updateFile<NamespacesData>(NAMESPACES_FILE, (data) => {
      for (const [name, ns] of Object.entries(data.namespaces ?? {})) {
        for (const [member, id] of Object.entries(ns[field] ?? {})) {
          if (drop.has(id)) delete ns[field][member];
        }
        if (Object.keys(ns.switches ?? {}).length === 0 && Object.keys(ns.variables ?? {}).length === 0) {
          delete data.namespaces[name];
        }
      }
    });
  }

  /** Every id this registry has handed out for `field`, regardless of what System.json's names say. */
  allocatedIds(field: NamespaceField): Set<number> {
    const ids = new Set<number>();
    for (const ns of Object.values(this.data()?.namespaces ?? {})) {
      for (const id of Object.values(ns[field] ?? {})) ids.add(id);
    }
    return ids;
  }

  /** `quest.herb.started` -> its allocated id. Throws (naming what *is* known) rather than returning undefined: a typo'd name must not silently become switch NaN/0. */
  resolve(field: NamespaceField, name: string): number {
    const dot = name.lastIndexOf('.');
    const id = dot === -1 ? undefined : this.data()?.namespaces[name.slice(0, dot)]?.[field]?.[name.slice(dot + 1)];
    if (id === undefined) {
      const known = this.names(field);
      throw new Error(
        `Unknown ${field === 'switches' ? 'switch' : 'variable'} name ${JSON.stringify(name)}. ` +
          (known.length > 0 ? `Known names: ${known.join(', ')}` : 'No namespaces allocated yet — call allocate_namespace first.')
      );
    }
    return id;
  }

  /** Inverse of resolve, for printing an existing event back as readable DSL. */
  nameOf(field: NamespaceField, id: number): string | undefined {
    for (const [namespace, ns] of Object.entries(this.data()?.namespaces ?? {})) {
      for (const [member, memberId] of Object.entries(ns[field] ?? {})) {
        if (memberId === id) return `${namespace}.${member}`;
      }
    }
    return undefined;
  }

  names(field: NamespaceField): string[] {
    const out: string[] = [];
    for (const [namespace, ns] of Object.entries(this.data()?.namespaces ?? {})) {
      for (const member of Object.keys(ns[field] ?? {})) out.push(`${namespace}.${member}`);
    }
    return out.sort();
  }

  /** The whole table, for rmmz://project/summary. `{}` when nothing was ever allocated. */
  list(): NamespacesData['namespaces'] {
    return this.data()?.namespaces ?? {};
  }
}
