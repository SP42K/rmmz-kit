import { describe, it, expect, afterEach } from 'vitest';
import { openProject } from '../src/session.js';
import { IdAllocator } from '../src/idAllocator.js';
import { NamespaceRegistry, NAMESPACES_FILE } from '../src/namespaces.js';
import { SystemData } from '../src/types/mz.js';
import { makeTestProject } from './testProject.js';

describe('IdAllocator', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('allocates a contiguous, named block of switches for a namespace', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const allocator = new IdAllocator(session);
    const alloc = allocator.allocNamespace('quest.herb', { switches: 3, variables: 2 });

    const switchIds = Object.values(alloc.switches);
    expect(switchIds).toHaveLength(3);
    expect(switchIds[1]).toBe(switchIds[0] + 1);
    expect(switchIds[2]).toBe(switchIds[0] + 2);
    expect(Object.values(alloc.variables)).toHaveLength(2);

    const system = session.readFile<SystemData>('System.json');
    expect(system.switches[alloc.switches['0']]).toBe('quest.herb.0');
    expect(system.switches[alloc.switches['2']]).toBe('quest.herb.2');
    expect(system.variables[alloc.variables['0']]).toBe('quest.herb.0');
  });

  it('named members mirror into System.json and resolve back through the registry', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const alloc = new IdAllocator(session).allocNamespace('quest.herb', {
      switches: ['started', 'done'],
      variables: ['count'],
    });

    const system = session.readFile<SystemData>('System.json');
    expect(system.switches[alloc.switches.started]).toBe('quest.herb.started');
    expect(system.switches[alloc.switches.done]).toBe('quest.herb.done');
    expect(system.variables[alloc.variables.count]).toBe('quest.herb.count');

    const registry = new NamespaceRegistry(session);
    expect(registry.resolve('switches', 'quest.herb.started')).toBe(alloc.switches.started);
    expect(registry.resolve('variables', 'quest.herb.count')).toBe(alloc.variables.count);
    expect(registry.nameOf('switches', alloc.switches.done)).toBe('quest.herb.done');
    expect(() => registry.resolve('switches', 'quest.herb.finished')).toThrow(/quest\.herb\.started/);
    expect(session.dirtyFiles()).toContain(NAMESPACES_FILE);
  });

  it('rejects member names that would break resolution', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const allocator = new IdAllocator(session);
    expect(() => allocator.allocNamespace('q', { switches: ['a.b'] })).toThrow(/no '\.'/);
    expect(() => allocator.allocNamespace('q', { switches: [''] })).toThrow(/non-empty/);
    expect(() => allocator.allocNamespace('q', { switches: ['a', 'a'] })).toThrow(/Duplicate/);
  });

  it('refuses to re-allocate a member the namespace already owns, instead of orphaning the first id', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const allocator = new IdAllocator(session);
    const first = allocator.allocNamespace('quest.herb', { switches: ['started'] });

    // Without the guard this handed out a second id, left two System.json
    // entries named quest.herb.started, and dropped the first from the registry
    // — re-opening M6.5 gap #2 for an id live events already reference.
    expect(() => allocator.allocNamespace('quest.herb', { switches: ['started'] })).toThrow(/already owns/);
    expect(new NamespaceRegistry(session).nameOf('switches', first.switches.started)).toBe('quest.herb.started');

    // A *different* member of the same namespace is still fine.
    expect(allocator.allocNamespace('quest.herb', { switches: ['done'] }).switches.done).not.toBe(
      first.switches.started
    );
  });

  it('occupancy survives System.json names being replaced whole (M6.5 gap #2)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const allocator = new IdAllocator(session);
    const first = allocator.allocSwitches('quest.a', 2);

    // What update_system's shallow merge does: the whole names array replaced,
    // wiping the mirror. Before the registry this made `first` look free again.
    session.updateFile<SystemData>('System.json', (data) => {
      data.switches = ['', 'Hand Named'];
    });

    const second = allocator.allocSwitches('quest.b', 2);
    expect(second).not.toContain(first[0]);
    expect(second).not.toContain(first[1]);
  });

  it('does not reuse an already-named switch, and reclaims it after release', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const allocator = new IdAllocator(session);

    const first = allocator.allocSwitches('quest.a', 1);
    const second = allocator.allocSwitches('quest.b', 1);
    expect(second[0]).not.toBe(first[0]);

    allocator.releaseSwitches(first);
    const system = session.readFile<SystemData>('System.json');
    expect(system.switches[first[0]]).toBe('');
    expect(new NamespaceRegistry(session).names('switches')).not.toContain('quest.a.0');

    const third = allocator.allocSwitches('quest.c', 1);
    expect(third[0]).toBe(first[0]);
  });

  it('allocating zero (or fewer) ids is a no-op instead of hanging', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const allocator = new IdAllocator(session);

    expect(allocator.allocSwitches('quest.none', 0)).toEqual([]);
    expect(allocator.allocVariables('quest.none', -1)).toEqual([]);
    expect(allocator.allocNamespace('quest.none', {})).toEqual({ namespace: 'quest.none', switches: {}, variables: {} });
  });

  it('allocEntityId finds the first free hole, else the next id past the end', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const allocator = new IdAllocator(session);

    // fixture Items.json has entries at ids 1..3, no holes.
    expect(allocator.allocEntityId('Items.json')).toBe(4);

    session.updateFile<unknown[]>('Items.json', (data) => {
      data[2] = null;
    });
    expect(allocator.allocEntityId('Items.json')).toBe(2);
  });
});
