#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openProject } from '@rmmz-kit/core';
import { createServer } from './server.js';

const projectPath = process.argv[2];
if (!projectPath) {
  console.error('Usage: rmmz-mcp <path-to-rpg-maker-mz-project>');
  process.exit(1);
}

const session = await openProject(projectPath);
await createServer(session).connect(new StdioServerTransport());
