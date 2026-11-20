import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { EventEmitter } from 'node:events';
import { EnvironmentVariables } from '../config/env.validation';

/** LISTEN лише пробуджує читачів. Після кожного успішного LISTEN вони перечитують БД. */
@Injectable()
export class ExecutionFeed implements OnApplicationShutdown {
  readonly events = new EventEmitter();
  private readonly logger = new Logger(ExecutionFeed.name);
  private client?: Client;
  private retry?: NodeJS.Timeout;
  private delay = 250;
  private stopped = false;
  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}
  start(): void {
    if (this.client || this.retry || this.stopped) return;
    const client = new Client({
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
      application_name: 'ff-realtime-listener',
      connectionTimeoutMillis: this.config.get('DB_CONNECT_TIMEOUT_MS', {
        infer: true,
      }),
      query_timeout: this.config.get('DB_STATEMENT_TIMEOUT_MS', {
        infer: true,
      }),
      keepAlive: true,
    });
    this.client = client;
    const lost = () => {
      if (client !== this.client) return;
      this.client = undefined;
      this.events.emit('available', false);
      void client
        .end()
        .catch(() => this.logger.warn('realtime listener close failed'));
      if (this.stopped) return;
      this.retry = setTimeout(
        () => {
          this.retry = undefined;
          this.start();
        },
        this.delay + Math.random() * 100,
      );
      this.delay = Math.min(15_000, this.delay * 2);
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', (msg) => {
      if (client === this.client && msg.payload)
        this.events.emit(msg.channel, msg.payload);
    });
    void (async () => {
      await client.connect();
      await client.query('LISTEN ff_execution; LISTEN ff_session_revoked');
      if (client !== this.client) return;
      this.delay = 250;
      this.events.emit('available', true);
    })().catch(lost);
  }
  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.retry);
    const client = this.client;
    this.client = undefined;
    if (client)
      await client
        .end()
        .catch(() => this.logger.warn('realtime listener close failed'));
  }
}
