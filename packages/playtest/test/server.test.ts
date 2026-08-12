import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPlaytestServer, type PlaytestServer } from '../src/server.js';
import { makeTestProject } from './testProject.js';

describe('playtest server', () => {
  let project: { dir: string; cleanup: () => Promise<void> };
  let server: PlaytestServer;

  beforeAll(async () => {
    project = await makeTestProject();
    server = await startPlaytestServer(project.dir);
  });

  afterAll(async () => {
    await server.close();
    await project.cleanup();
  });

  it('serves the project files a running game fetches', async () => {
    const res = await fetch(`${server.url}data/Map001.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).width).toBe(17);
  });

  it('serves index.html for the directory root', async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<!DOCTYPE html>');
  });

  it('404s a missing file instead of hanging the loader', async () => {
    expect((await fetch(`${server.url}data/Map999.json`)).status).toBe(404);
  });

  it('refuses to escape the project root', async () => {
    // Encoded, so the check has to survive decodeURIComponent — a raw `..` is
    // normalised away by fetch/Node before the server ever sees it.
    for (const path of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f%2e%2e%2fpackage.json']) {
      const res = await fetch(`${server.url}${path}`);
      expect([403, 404]).toContain(res.status);
    }
  });
});
