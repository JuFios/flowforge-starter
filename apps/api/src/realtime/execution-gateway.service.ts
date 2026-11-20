import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Express } from 'express';
import { normalizeIp } from '@nestjs/throttler';
import { WebSocket, WebSocketServer } from 'ws';
import { Gauge, Counter } from 'prom-client';
import { EnvironmentVariables } from '../config/env.validation';
import { MetricsService } from '../observability/metrics.service';
import { SystemDb } from '../tenancy/system-db';
import { tokenHash } from '../sessions/sessions.service';
import { ExecutionReader } from '../executions/execution-reader.service';
import { ExecutionFeed } from './execution-feed.service';

type Grant = NonNullable<Awaited<ReturnType<SystemDb['redeemTicket']>>>;
type Verify = (
  ok: boolean,
  code?: number,
  text?: string,
  headers?: Record<string, string>,
) => void;
interface Subscription {
  grant: Grant;
  revision?: string;
  dirty: boolean;
  reading: boolean;
  alive: boolean;
}
const BUFFER_LIMIT = 256 * 1024;
/** Сокети з однаковим ключем отримують знімок з одного читання. */
const groupKey = ({ grant }: Subscription) =>
  `${grant.tenantId}:${grant.executionId}:${grant.sessionId ?? ''}`;

@Injectable()
export class ExecutionGateway
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ExecutionGateway.name);
  private readonly pending = new WeakMap<IncomingMessage, Grant>();
  private readonly subscriptions = new Map<WebSocket, Subscription>();
  /** Групи, чий знімок зараз читається (ключ groupKey). */
  private readonly readingGroups = new Set<string>();
  private checking = 0;
  private activeReads = 0;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private adapter?: WsAdapter;
  private server?: WebSocketServer;
  private readonly connections: Gauge;
  private readonly listenUp: Gauge;
  private readonly resyncs: Counter;
  private readonly slow: Counter;
  constructor(
    private readonly http: HttpAdapterHost,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly reader: ExecutionReader,
    private readonly system: SystemDb,
    private readonly feed: ExecutionFeed,
    metrics: MetricsService,
  ) {
    const registers = [metrics.registry];
    this.connections = new Gauge({
      name: 'flowforge_realtime_connections',
      help: 'Active execution subscriptions on this API',
      registers,
    });
    this.listenUp = new Gauge({
      name: 'flowforge_realtime_listen_up',
      help: 'Postgres realtime listener is connected',
      registers,
    });
    this.resyncs = new Counter({
      name: 'flowforge_realtime_resyncs_total',
      help: 'Subscription refreshes after LISTEN is established',
      registers,
    });
    this.slow = new Counter({
      name: 'flowforge_realtime_dropped_slow_total',
      help: 'Slow subscribers disconnected',
      registers,
    });
  }
  onApplicationBootstrap() {
    const http = this.http.httpAdapter.getHttpServer() as Server;
    this.adapter = new WsAdapter(http);
    this.server = this.adapter.create(0, {
      path: '/realtime',
      maxPayload: 512,
      perMessageDeflate: false,
      verifyClient: (info: { req: IncomingMessage }, done: Verify) =>
        this.verify(info.req, done),
    }) as WebSocketServer;
    this.server.on(
      'connection',
      (socket: WebSocket, request: IncomingMessage) =>
        this.subscribe(socket, request),
    );
    this.feed.events.on('ff_execution', (key: string) => {
      for (const sub of this.subscriptions.values())
        if (key === sub.grant.tenantId + ':' + sub.grant.executionId)
          sub.dirty = true;
      this.drain();
    });
    this.feed.events.on('ff_session_revoked', (id: string) => {
      for (const [socket, sub] of this.subscriptions)
        if (sub.grant.sessionId === id) socket.close(4401, 'session revoked');
    });
    this.feed.events.on('available', (up: boolean) => {
      this.listenUp.set(up ? 1 : 0);
      if (up) {
        this.resyncs.inc();
        this.refreshAll();
      }
    });
    this.timer = setInterval(() => {
      for (const [ws, sub] of this.subscriptions) {
        if (!sub.alive) {
          ws.terminate();
          continue;
        }
        sub.alive = false;
        ws.ping();
        this.send(ws, '{"type":"heartbeat"}');
      }
      this.refreshAll();
    }, 15_000);
  }
  private verify(req: IncomingMessage, done: Verify) {
    if (
      this.closed ||
      this.checking >= 32 ||
      this.subscriptions.size >=
        this.config.get('REALTIME_MAX_CONNECTIONS', { infer: true })
    )
      return done(false, 429, 'Too Many Requests', { 'Retry-After': '1' });
    this.checking++;
    const expire = setTimeout(() => req.socket.destroy(), 8000);
    void this.authorize(req, done)
      .catch(() => {
        if (!req.socket.destroyed) done(false, 503, 'Service Unavailable');
      })
      .finally(() => {
        clearTimeout(expire);
        this.checking--;
      });
  }
  private async authorize(req: IncomingMessage, done: Verify) {
    const match = /^\/realtime\?ticket=(fft_[0-9a-f]{64})$/.exec(req.url ?? '');
    const grant = match
      ? await this.system.redeemTicket(tokenHash(match[1]))
      : undefined;
    if (req.socket.destroyed) return;
    if (!grant) {
      const peer = req.socket.remoteAddress ?? 'unknown';
      const express: Express = this.http.httpAdapter.getInstance();
      const trust = express.get('trust proxy fn') as (
        ip: string,
        index: number,
      ) => boolean;
      const chain =
        typeof req.headers['x-forwarded-for'] === 'string'
          ? req.headers['x-forwarded-for']
              .split(',')
              .map((v) => v.trim())
              .reverse()
          : [];
      let ip = peer;
      for (let i = 0; i < chain.length && trust(ip, i); i++) ip = chain[i];
      const limit = this.config.get('AUTH_FAILURE_RATE_LIMIT', { infer: true });
      const { hits, resetMs } = await this.system.rateLimitHit(
        'auth-failures:' + normalizeIp(ip),
        this.config.get('AUTH_FAILURE_RATE_WINDOW_MS', { infer: true }),
        1,
      );
      if (req.socket.destroyed) return;
      if (hits > limit)
        return done(false, 429, 'Too Many Requests', {
          'Retry-After': String(Math.max(1, Math.ceil(resetMs / 1000))),
        });
      return done(false, 401, 'Unauthorized');
    }
    if (this.closed) return done(false, 503, 'Service Unavailable');
    let used = 0;
    for (const sub of this.subscriptions.values())
      if (sub.grant.tenantId === grant.tenantId) used++;
    if (
      used >=
        this.config.get('REALTIME_MAX_CONNECTIONS_PER_TENANT', {
          infer: true,
        }) ||
      this.subscriptions.size >=
        this.config.get('REALTIME_MAX_CONNECTIONS', { infer: true })
    )
      return done(false, 429, 'Too Many Requests', { 'Retry-After': '1' });
    this.pending.set(req, grant);
    done(true);
  }
  private subscribe(socket: WebSocket, req: IncomingMessage) {
    const grant = this.pending.get(req);
    this.pending.delete(req);
    if (!grant || this.closed) return socket.terminate();
    const sub: Subscription = {
      grant,
      reading: false,
      dirty: true,
      alive: true,
    };
    this.subscriptions.set(socket, sub);
    this.connections.inc();
    socket.on('pong', () => {
      sub.alive = true;
    });
    socket.on('message', () => socket.close(1003, 'read only'));
    socket.once('close', () => {
      this.subscriptions.delete(socket);
      this.connections.dec();
    });
    this.feed.start();
    this.drain();
  }
  private send(socket: WebSocket, message: string) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount + Buffer.byteLength(message) > BUFFER_LIMIT) {
      this.slow.inc();
      socket.close(4008, 'slow consumer');
      return;
    }
    socket.send(message, (err) => {
      if (err) socket.terminate();
    });
  }
  private refreshAll() {
    for (const sub of this.subscriptions.values()) sub.dirty = true;
    this.drain();
  }
  /**
   * Знімок читається один раз на групу сокетів із тим самим тенантом, виконанням і сесією
   * (перевірка сесії — частина того самого SQL), тож кілька вкладок одного користувача на одному
   * виконанні не множать запити до БД. Поки група читається, нові сповіщення лише позначають її
   * брудною, і після читання вона перечитується ще раз.
   */
  private drain() {
    if (this.closed) return;
    for (const [ws, sub] of this.subscriptions) {
      if (this.activeReads >= 4) break;
      if (!sub.dirty || sub.reading || ws.readyState !== WebSocket.OPEN)
        continue;
      const key = groupKey(sub);
      if (this.readingGroups.has(key)) continue;
      const group: Array<[WebSocket, Subscription]> = [];
      for (const [other, candidate] of this.subscriptions)
        if (
          groupKey(candidate) === key &&
          candidate.dirty &&
          other.readyState === WebSocket.OPEN
        )
          group.push([other, candidate]);
      for (const [, member] of group) {
        member.dirty = false;
        member.reading = true;
      }
      this.readingGroups.add(key);
      this.activeReads++;
      void this.refresh(sub.grant, group).finally(() => {
        this.readingGroups.delete(key);
        for (const [member, state] of group) {
          state.reading = false;
          // Група стає в кінець черги: інші виконання не чекають на одне гаряче.
          if (this.subscriptions.delete(member))
            this.subscriptions.set(member, state);
        }
        this.activeReads--;
        this.drain();
      });
    }
  }
  private async refresh(grant: Grant, group: Array<[WebSocket, Subscription]>) {
    const { tenantId, executionId, sessionId, sessionExpiresAt } = grant;
    if (sessionExpiresAt && sessionExpiresAt.getTime() <= Date.now()) {
      for (const [ws] of group) ws.close(4401, 'session expired');
      return;
    }
    let execution: Awaited<ReturnType<ExecutionReader['summary']>>;
    try {
      execution = await this.reader.summary(
        tenantId,
        executionId,
        sessionId ?? undefined,
      );
    } catch (err) {
      for (const [ws] of group)
        if (err instanceof NotFoundException) ws.close(4404, 'unavailable');
        else ws.close(1013, 'retry later');
      return;
    }
    const message = JSON.stringify({ type: 'snapshot', execution });
    for (const [ws, sub] of group) {
      if (
        sub.revision === execution.revision ||
        ws.readyState !== WebSocket.OPEN
      )
        continue;
      this.send(ws, message);
      sub.revision = execution.revision;
    }
  }
  async beforeApplicationShutdown() {
    this.closed = true;
    clearInterval(this.timer);
    this.feed.events.removeAllListeners();
    if (this.server && this.adapter)
      await this.adapter
        .close(this.server)
        .catch(() => this.logger.warn('realtime server close failed'));
  }
}
