import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { Client } from 'pg';

/** Як часто перевіряти, що з'єднання LISTEN живе. */
const LIVENESS_INTERVAL_MS = 10_000;

export interface PgListenerOptions {
  connectionString: string;
  /** Канали `LISTEN`; подія EventEmitter — ім'я каналу з payload сповіщення. */
  channels: readonly string[];
  /** `application_name` з'єднання (видно в pg_stat_activity). */
  applicationName: string;
  connectTimeoutMs: number;
  queryTimeoutMs: number;
}

/**
 * Окреме з'єднання `LISTEN` з перепідключенням (backoff 0,25…15 с з jitter) і перевіркою живості.
 * Сповіщення лише будять читачів: після кожного успішного `LISTEN` подія `available` (true) —
 * сигнал перечитати стан, бо сповіщення, надіслані поки з'єднання не було, загублено. Втрата
 * з'єднання — `available` (false).
 */
export class PgListener {
  readonly events = new EventEmitter();
  private readonly logger: Logger;
  private client?: Client;
  private retry?: NodeJS.Timeout;
  private probe?: NodeJS.Timeout;
  private delay = 250;
  private stopped = false;

  constructor(
    private readonly options: () => PgListenerOptions,
    loggerName: string,
  ) {
    this.logger = new Logger(loggerName);
  }

  /** Чи з'єднання `LISTEN` зараз встановлене. */
  get listening(): boolean {
    return this.client !== undefined && this.retry === undefined;
  }

  start(): void {
    if (this.client || this.retry || this.stopped) return;
    const options = this.options();
    const client = new Client({
      connectionString: options.connectionString,
      application_name: options.applicationName,
      connectionTimeoutMillis: options.connectTimeoutMs,
      query_timeout: options.queryTimeoutMs,
      keepAlive: true,
    });
    this.client = client;
    const lost = () => {
      if (client !== this.client) return;
      this.client = undefined;
      clearInterval(this.probe);
      this.probe = undefined;
      this.events.emit('available', false);
      void client.end().catch(() => this.logger.warn('listener close failed'));
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
      await client.query(
        options.channels.map((channel) => `LISTEN ${channel}`).join('; '),
      );
      if (client !== this.client) return;
      this.delay = 250;
      // Напіввідкрите з'єднання (NAT чи firewall мовчки відкинули його) не дає ні error, ні end:
      // запит із таймаутом виявляє його, і після перепідключення підписки перечитуються.
      this.probe = setInterval(() => {
        client.query('SELECT 1').catch(lost);
      }, LIVENESS_INTERVAL_MS);
      this.events.emit('available', true);
    })().catch(lost);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.probe);
    const client = this.client;
    this.client = undefined;
    if (client)
      await client.end().catch(() => this.logger.warn('listener close failed'));
  }
}
