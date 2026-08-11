import { describe, it, expect, afterEach } from 'vitest';
import { openProject } from '../src/session.js';
import { IdAllocator } from '../src/idAllocator.js';
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

    expect(alloc.switches).toHaveLength(3);
    expect(alloc.switches[1]).toBe(alloc.switches[0] + 1);
    expect(alloc.switches[2]).toBe(alloc.switches[0] + 2);
    expect(alloc.variables).toHaveLength(2);

    const system = session.readFile<SystemData>('System.json');
    expect(system.switches[alloc.switches[0]]).toBe('quest.herb.0');
    expect(system.switches[alloc.switches[2]]).toBe('quest.herb.2');
    expect(system.variables[alloc.variables[0]]).toBe('quest.herb.0');
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

    const third = allocator.allocSwitches('quest.c', 1);
    expect(third[0]).toBe(first[0]);
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
