import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { EnvironmentVariables } from '../config/env.validation';
import { toSafeError } from './safe-error';
import { MetricsService } from './metrics.service';

/**
 * Службовий HTTP-порт API лише для `GET /metrics` (METRICS_PORT). Публічний порт API
 * опублікований назовні, тому метрики там не віддаються; цей порт docker-compose не публікує,
 * збирач метрик звертається до нього з внутрішньої мережі. Воркер віддає метрики на своєму
 * службовому порту (WORKER_HTTP_PORT), де й так немає публічних маршрутів.
 */
@Injectable()
export class MetricsServer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MetricsServer.name);
  private server?: Server;

  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Фактичний порт (важливо, коли METRICS_PORT=0 — випадковий вільний порт). */
  get port(): number | undefined {
    const address = this.server?.address() as AddressInfo | null | undefined;
    return address?.port;
  }

  async onApplicationBootstrap(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.get('METRICS_PORT', { infer: true }), () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.logger.log(`metrics endpoint on ${this.port}`);
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive з'єднання збирача інакше тримали б закриття до свого таймауту.
      server.closeAllConnections();
    });
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (
      path !== '/metrics' ||
      (req.method !== 'GET' && req.method !== 'HEAD')
    ) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
      return;
    }
    try {
      const body = await this.metrics.render();
      res.writeHead(200, { 'content-type': this.metrics.contentType() });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      this.logger.error({ error: toSafeError(err) }, 'metrics: render failed');
      res
        .writeHead(500, { 'content-type': 'text/plain' })
        .end('Internal Server Error');
    }
  }
}
