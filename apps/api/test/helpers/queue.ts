import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { WorkerModule } from '../../src/app.module';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { RunningApp, startApp } from './app';

/** Чекає, поки `check` поверне істину, опитуючи кожні `intervalMs`; інакше — помилка з `what`. */
export async function waitFor(
  what: string,
  check: () => Promise<boolean> | boolean,
  { timeoutMs = 15_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Воркер (WorkerModule) зі своїм пулом з'єднань і запущеними циклами обробки. */
export async function startWorker(concurrency = 2): Promise<RunningApp> {
  const worker = await startApp(WorkerModule);
  worker.app.get(JobRunnerService).start(concurrency);
  return worker;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type Responder = (
  req: ReceivedRequest,
  res: ServerResponse,
) => void | Promise<void>;

/**
 * Зовнішній отримувач http-кроків: записує кожен запит; відповідь — від `respond`
 * (за замовчуванням 200 з JSON `{ ok: true }`).
 */
export class Receiver {
  readonly requests: ReceivedRequest[] = [];
  private server?: Server;
  respond: Responder = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };

  async start(): Promise<void> {
    // Дозвіл тестового приймача один на процес: другий приймач мовчки перебрав би його в першого.
    if (process.env.HTTP_FIXTURE_ORIGIN !== undefined)
      throw new Error(
        `another HTTP fixture is active: ${process.env.HTTP_FIXTURE_ORIGIN}`,
      );
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const received: ReceivedRequest = {
          method: req.method ?? '',
          path: (req.url ?? '').split('?')[0],
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        this.requests.push(received);
        void Promise.resolve(this.respond(received, res)).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    process.env.HTTP_FIXTURE_ORIGIN = this.url('');
    process.env.HTTP_FIXTURE_ADDRESS = '127.0.0.1';
  }

  url(path: string): string {
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}${path}`;
  }

  hits(path: string): ReceivedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    if (process.env.HTTP_FIXTURE_ORIGIN === this.url('')) {
      delete process.env.HTTP_FIXTURE_ORIGIN;
      delete process.env.HTTP_FIXTURE_ADDRESS;
    }
    this.server = undefined;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** JSON-запит до API з ключем тенанта. */
export async function api<T = unknown>(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : undefined) as T,
  };
}
