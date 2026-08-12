import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * The M8 "front half" (plan §3 M8): a local static site over the project root,
 * which is the editor's Playtest button's equivalent (§0). MZ's index.html
 * `fetch`es data/*.json, so `file://` fails on CORS — a server is the whole
 * requirement, and `node:http` covers it in fifty lines. The plan named
 * `serve-handler` (§5) because the reference repo already depended on it; a
 * dependency to serve one directory is not worth the supply chain.
 *
 * Deliberately not here: cache headers, range requests, compression. A playtest
 * server is one browser on localhost reading local files.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface PlaytestServerOptions {
  /** 0 (the default) takes an ephemeral port — two playtests can run at once. */
  port?: number;
  /** Loopback by default: this serves a whole project directory, including its git-tracked source. */
  host?: string;
  /** Open the URL in the OS default browser once listening. */
  openBrowser?: boolean;
}

export interface PlaytestServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startPlaytestServer(rootPath: string, options: PlaytestServerOptions = {}): Promise<PlaytestServer> {
  const root = path.resolve(rootPath);
  const host = options.host ?? '127.0.0.1';

  const server = http.createServer((req, res) => {
    void serve(root, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://${host}:${port}/`;
  if (options.openBrowser) openInBrowser(url);

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function serve(root: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    return end(res, 400, 'Bad request');
  }

  // Containment check, not a `..` string filter: `path.resolve` collapses the
  // traversal (including the encoded and mixed-separator spellings) and the
  // relative-path test is what actually decides. Serving a project directory
  // means serving whatever else the user keeps under it, so this is a real
  // trust boundary even on loopback.
  const target = path.resolve(root, `.${path.sep}${pathname}`);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return end(res, 403, 'Forbidden');

  let file = target;
  const info = await stat(file).catch(() => null);
  if (info?.isDirectory()) file = path.join(file, 'index.html');
  else if (!info) return end(res, 404, 'Not found');

  const fileInfo = file === target ? info : await stat(file).catch(() => null);
  if (!fileInfo?.isFile()) return end(res, 404, 'Not found');

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': fileInfo.size,
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

function end(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  // Detached and unref'd: the browser outliving this process is the point, and
  // a missing xdg-open on a headless box must not take the MCP server with it.
  const child = spawn(command, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
