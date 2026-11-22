import type { ExecutionSummary } from './types';

/**
 * Підписка сторінки виконання на зміни (README, «Протокол WebSocket»). Джерело істини — БД:
 * кожне повідомлення сервера — повний знімок виконання з монотонною ревізією, а не дельта. Тому
 * пропущене повідомлення не залишає сторінку в неправильному стані: наступний знімок (після
 * перепідключення, страхувального перечитування сервера чи HTTP-опитування) повертає істину.
 *
 * Правила:
 * - більша ревізія замінює знімок виконання. У тій самій ревізії лише чинний сокет або послідовне
 *   опитування можуть оновити назву workflow, яка зберігається окремо;
 * - кожна спроба підключення отримує новий одноразовий тикет; події попередніх спроб
 *   відкидаються за номером покоління;
 * - перепідключення з експоненційним backoff і jitter (0,5…30 с), після трьох невдач паралельно
 *   вмикається HTTP-опитування знімка, доки сокет не відновиться;
 * - тиша довше за WATCHDOG_MS (сервер шле heartbeat кожні 15 с) означає мертве з'єднання;
 * - stop() звільняє все: сокет, таймери, незавершене отримання тикета й опитування.
 */
export type StreamState =
  'connecting' | 'live' | 'reconnecting' | 'polling' | 'gone' | 'stopped';

export type TicketResult =
  | { ok: true; ticket: string }
  | { ok: false; reason: 'gone' | 'session' | 'retry'; retryAfterMs?: number };

export type SummaryResult =
  | { ok: true; summary: ExecutionSummary }
  | { ok: false; reason: 'gone' | 'session' | 'retry'; retryAfterMs?: number };

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface StreamDeps {
  /** HTTP-адаптер обмежує тривалість запитів і реагує на скасування від потоку. */
  issueTicket(signal: AbortSignal): Promise<TicketResult>;
  fetchSummary(signal: AbortSignal): Promise<SummaryResult>;
  openSocket(ticket: string): SocketLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  random(): number;
}

export interface StreamEvents {
  onSnapshot(summary: ExecutionSummary): void;
  onState(state: StreamState): void;
  onSessionExpired(): void;
}

export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 30_000;
export const WATCHDOG_MS = 45_000;
export const POLL_INTERVAL_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;
export const POLL_AFTER_FAILURES = 3;
/** Найбільше повідомлення, яке клієнт розбирає (знімок без виходів кроків значно менший). */
export const MAX_MESSAGE_CHARS = 1_048_576;

/** Ревізія — bigint у рядку; порівнюємо без втрати точності. */
export function newer(candidate: string, current: string | undefined): boolean {
  if (current === undefined) return true;
  if (candidate.length !== current.length)
    return candidate.length > current.length;
  return candidate > current;
}

export function backoffMs(failures: number, random: () => number): number {
  const base = Math.min(
    BACKOFF_MAX_MS,
    BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1),
  );
  // «Equal jitter»: половина інтервалу гарантована, половина випадкова — інстанси не б'ють
  // сервер синхронно після його перезапуску.
  return Math.round(base / 2 + random() * (base / 2));
}

export class ExecutionStream {
  private current: ExecutionSummary | undefined;
  private generation = 0;
  private failures = 0;
  private stopped = false;
  private state: StreamState = 'connecting';
  private socket: SocketLike | undefined;
  private ticketAbort: AbortController | undefined;
  private pollAbort: AbortController | undefined;
  private reconnectTimer: unknown;
  private watchdogTimer: unknown;
  private pollTimer: unknown;
  private polling = false;
  private nextSummaryAt = 0;
  private nextTicketAt = 0;

  constructor(
    private readonly executionId: string,
    private readonly deps: StreamDeps,
    private readonly events: StreamEvents,
  ) {}

  /** Початковий знімок (із серверного рендеру) — та сама перевірка ревізії. */
  seed(summary: ExecutionSummary | undefined): void {
    if (summary) this.apply(summary);
  }

  start(): void {
    void this.connect();
  }

  fetchInitialSummary(): void {
    void this.readSummary();
  }

  /** Мережа повернулася: не чекати решту backoff. */
  nudge(): void {
    if (this.stopped || this.state === 'live' || this.state === 'gone') return;
    this.deps.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.deps.now() < this.nextTicketAt)
      this.armReconnect(this.nextTicketAt);
    else void this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.teardownSocket();
    this.ticketAbort?.abort();
    this.stopPolling();
    this.deps.clearTimeout(this.reconnectTimer);
    this.setState('stopped');
  }

  snapshot(): ExecutionSummary | undefined {
    return this.current;
  }

  private setState(state: StreamState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onState(state);
  }

  private apply(summary: ExecutionSummary, refreshName = false): void {
    if (summary.id !== this.executionId) return;
    const previous = this.current;
    if (newer(summary.revision, previous?.revision)) {
      this.current = summary;
    } else if (
      refreshName &&
      previous &&
      summary.revision === previous.revision &&
      summary.workflowName !== previous.workflowName
    ) {
      this.current = { ...previous, workflowName: summary.workflowName };
    } else {
      return;
    }
    this.events.onSnapshot(this.current);
  }

  private teardownSocket(): void {
    this.deps.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close(1000, 'client closed');
  }

  private gone(): void {
    this.generation++;
    this.teardownSocket();
    this.ticketAbort?.abort();
    this.stopPolling();
    this.deps.clearTimeout(this.reconnectTimer);
    this.setState('gone');
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.teardownSocket();
    this.setState(
      this.failures === 0
        ? 'connecting'
        : this.polling
          ? 'polling'
          : 'reconnecting',
    );
    this.ticketAbort?.abort();
    const abort = new AbortController();
    this.ticketAbort = abort;
    const ticket = await this.deps
      .issueTicket(abort.signal)
      .catch(() => undefined);
    if (gen !== this.generation || this.stopped) return;
    this.ticketAbort = undefined;
    if (!ticket) return this.scheduleReconnect();
    if (!ticket.ok) {
      if (ticket.reason === 'gone') return this.gone();
      if (ticket.reason === 'session') {
        this.stop();
        return this.events.onSessionExpired();
      }
      return this.scheduleReconnect(ticket.retryAfterMs);
    }
    let socket: SocketLike;
    try {
      socket = this.deps.openSocket(ticket.ticket);
    } catch {
      return this.scheduleReconnect();
    }
    this.socket = socket;
    this.armWatchdog(gen);
    socket.onmessage = (ev) => {
      if (gen !== this.generation) return;
      this.armWatchdog(gen);
      if (typeof ev.data !== 'string' || ev.data.length > MAX_MESSAGE_CHARS)
        return;
      let message: { type?: unknown; execution?: unknown };
      try {
        message = JSON.parse(ev.data) as typeof message;
      } catch {
        return;
      }
      if (message.type === 'snapshot' && message.execution) {
        const snapshot = message.execution as ExecutionSummary;
        if (snapshot.id !== this.executionId) return;
        this.failures = 0;
        this.stopPolling();
        this.setState('live');
        this.apply(snapshot, true);
      } else if (message.type === 'gone') this.gone();
    };
    socket.onerror = () => undefined;
    socket.onclose = (ev) => {
      if (gen !== this.generation) return;
      this.socket = undefined;
      this.deps.clearTimeout(this.watchdogTimer);
      if (ev.code === 4401) {
        this.stop();
        return this.events.onSessionExpired();
      }
      if (ev.code === 4404 || ev.code === 4403) return this.gone();
      this.scheduleReconnect();
    };
  }

  private armWatchdog(gen: number): void {
    this.deps.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = this.deps.setTimeout(() => {
      if (gen !== this.generation) return;
      // Тиша означає мертве з'єднання, навіть якщо браузер вважає сокет відкритим.
      this.generation++;
      this.teardownSocket();
      this.scheduleReconnect();
    }, WATCHDOG_MS);
  }

  private scheduleReconnect(minDelayMs = 0): void {
    if (this.stopped) return;
    this.failures++;
    if (this.failures >= POLL_AFTER_FAILURES) this.startPolling();
    this.setState(this.polling ? 'polling' : 'reconnecting');
    const now = this.deps.now();
    this.nextTicketAt = now + minDelayMs;
    this.armReconnect(
      Math.max(
        this.nextTicketAt,
        now + backoffMs(this.failures, this.deps.random),
      ),
    );
  }

  private armReconnect(at: number): void {
    this.deps.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.deps.setTimeout(
      () => {
        this.reconnectTimer = undefined;
        if (this.deps.now() < at) this.armReconnect(at);
        else void this.connect();
      },
      Math.min(Math.max(0, at - this.deps.now()), MAX_TIMER_MS),
    );
  }

  private startPolling(): void {
    if (this.polling || this.stopped) return;
    this.polling = true;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (!this.polling || this.pollAbort) return;
    const wait = Math.max(0, this.nextSummaryAt - this.deps.now());
    this.pollTimer = this.deps.setTimeout(
      () => {
        this.pollTimer = undefined;
        if (this.deps.now() < this.nextSummaryAt) this.schedulePoll();
        else void this.readSummary();
      },
      Math.min(wait, MAX_TIMER_MS),
    );
  }

  private async readSummary(): Promise<void> {
    if (this.pollAbort || this.stopped || this.state === 'gone') return;
    const abort = new AbortController();
    this.pollAbort = abort;
    const result = await this.deps
      .fetchSummary(abort.signal)
      .catch(() => undefined);
    if (this.pollAbort !== abort) return;
    this.pollAbort = undefined;
    if (result?.ok) this.apply(result.summary, true);
    else if (result?.reason === 'gone') return this.gone();
    else if (result?.reason === 'session') {
      this.stop();
      return this.events.onSessionExpired();
    }
    const retryAfter = result?.ok === false ? (result.retryAfterMs ?? 0) : 0;
    if (this.polling || retryAfter > 0)
      this.nextSummaryAt =
        this.deps.now() + Math.max(POLL_INTERVAL_MS, retryAfter);
    this.schedulePoll();
  }

  private stopPolling(): void {
    this.polling = false;
    this.deps.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollAbort?.abort();
    this.pollAbort = undefined;
  }
}
