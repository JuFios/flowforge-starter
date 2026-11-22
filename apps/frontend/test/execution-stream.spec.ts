import { expect, test } from '@playwright/test';
import {
  backoffMs,
  BACKOFF_MAX_MS,
  ExecutionStream,
  newer,
  POLL_INTERVAL_MS,
  WATCHDOG_MS,
  type SocketLike,
  type StreamDeps,
  type StreamState,
  type SummaryResult,
  type TicketResult,
} from '../lib/execution-stream';
import type { ExecutionSummary } from '../lib/types';

/**
 * Автомат підписки сторінки виконання без браузера: керований годинник, фальшиві сокети й
 * тикети. Перевіряє властивості, від яких залежить «зрештою фактичний стан» і відсутність витоків.
 */
const ID = '11111111-1111-4111-8111-111111111111';

function summary(
  revision: string,
  status = 'running',
  id = ID,
): ExecutionSummary {
  return {
    id,
    workflowId: 'w',
    workflowName: 'wf',
    workflowVersion: 1,
    status: status as ExecutionSummary['status'],
    trigger: 'api',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    scheduledAt: null,
    correlationId: null,
    revision,
    terminalCycles: 0,
    outputBytes: null,
    inputBytes: 2,
    plan: [],
    steps: [],
  };
}

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  constructor(readonly ticket: string) {}
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  send(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

function harness(
  options: {
    tickets?: () => Promise<TicketResult>;
    summaries?: () => Promise<SummaryResult>;
  } = {},
) {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const snapshots: ExecutionSummary[] = [];
  const states: StreamState[] = [];
  let tickets = 0;
  let summaryCalls = 0;
  const aborts: AbortSignal[] = [];
  let expired = false;
  const deps: StreamDeps = {
    issueTicket: (signal) => {
      tickets++;
      aborts.push(signal);
      return options.tickets
        ? options.tickets()
        : Promise.resolve({ ok: true, ticket: `t${tickets}` });
    },
    fetchSummary: (signal) => {
      summaryCalls++;
      aborts.push(signal);
      return options.summaries
        ? options.summaries()
        : Promise.resolve({ ok: false, reason: 'retry' });
    },
    openSocket: (ticket) => {
      const socket = new FakeSocket(ticket);
      sockets.push(socket);
      return socket;
    },
    setTimeout: (fn, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    random: () => 0.5,
  };
  const stream = new ExecutionStream(ID, deps, {
    onSnapshot: (s) => snapshots.push(s),
    onState: (s) => states.push(s),
    onSessionExpired: () => {
      expired = true;
    },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = target;
    await flush();
  }
  return {
    stream,
    sockets,
    snapshots,
    states,
    timers,
    aborts,
    flush,
    advance,
    get tickets() {
      return tickets;
    },
    get summaryCalls() {
      return summaryCalls;
    },
    get expired() {
      return expired;
    },
  };
}

test('compares bigint revisions without losing precision', () => {
  expect(newer('10', '9')).toBe(true);
  expect(newer('9', '10')).toBe(false);
  expect(newer('9007199254740993', '9007199254740992')).toBe(true);
  expect(newer('5', '5')).toBe(false);
  expect(newer('1', undefined)).toBe(true);
});

test('backoff doubles with jitter between half and the full interval, capped at 30 s', () => {
  expect(backoffMs(1, () => 0)).toBe(250);
  expect(backoffMs(1, () => 1)).toBe(500);
  expect(backoffMs(4, () => 1)).toBe(4000);
  expect(backoffMs(50, () => 1)).toBe(BACKOFF_MAX_MS);
});

test('applies only newer snapshots of this execution, so a late response cannot roll the page back', async () => {
  const h = harness();
  h.stream.seed(summary('5'));
  h.stream.start();
  await h.flush();
  const socket = h.sockets[0];
  socket.open();
  socket.send({ type: 'snapshot', execution: summary('7', 'succeeded') });
  socket.send({ type: 'snapshot', execution: summary('6', 'running') });
  socket.send({
    type: 'snapshot',
    execution: summary('9', 'failed', '22222222-2222-4222-8222-222222222222'),
  });
  h.stream.seed(summary('4', 'pending'));
  expect(h.snapshots.map((s) => [s.revision, s.status])).toEqual([
    ['5', 'running'],
    ['7', 'succeeded'],
  ]);
  h.stream.stop();
});

test('refreshes the live workflow name at the same revision without rolling back execution state', async () => {
  const h = harness();
  h.stream.seed(summary('7', 'succeeded'));
  h.stream.start();
  await h.flush();
  const socket = h.sockets[0];
  socket.send({
    type: 'snapshot',
    execution: { ...summary('7', 'failed'), workflowName: 'renamed' },
  });
  h.stream.seed(summary('7', 'running'));
  socket.send({ type: 'snapshot', execution: summary('6', 'pending') });
  expect(h.stream.snapshot()).toMatchObject({
    workflowName: 'renamed',
    status: 'succeeded',
  });
  socket.send({
    type: 'snapshot',
    execution: { ...summary('7'), workflowName: null },
  });
  expect(h.stream.snapshot()).toMatchObject({
    workflowName: null,
    status: 'succeeded',
  });
  h.stream.stop();
});

test('retries a ticket and fallback poll after the HTTP adapter reports a deadline', async () => {
  let releaseTicket: (result: TicketResult) => void = () => undefined;
  let releasePoll: (result: SummaryResult) => void = () => undefined;
  const firstTicket = new Promise<TicketResult>((resolve) => {
    releaseTicket = resolve;
  });
  const firstPoll = new Promise<SummaryResult>((resolve) => {
    releasePoll = resolve;
  });
  let ticketCalls = 0;
  let pollCalls = 0;
  const h = harness({
    tickets: async () =>
      ++ticketCalls === 1 ? firstTicket : { ok: false, reason: 'retry' },
    summaries: async () =>
      ++pollCalls === 1 ? firstPoll : { ok: true, summary: summary('7') },
  });

  h.stream.start();
  await h.advance(30_000);
  expect(h.aborts[0].aborted).toBe(false);
  expect(h.tickets).toBe(1);
  releaseTicket({ ok: false, reason: 'retry' });
  await h.flush();
  await h.advance(2_000);
  expect(h.states.at(-1)).toBe('polling');
  expect(h.summaryCalls).toBe(1);
  await h.advance(30_000);
  expect(h.summaryCalls).toBe(1);
  releasePoll({ ok: false, reason: 'retry' });
  await h.flush();
  await h.advance(POLL_INTERVAL_MS);
  expect(h.summaryCalls).toBe(2);
  expect(h.stream.snapshot()?.revision).toBe('7');
  expect(h.sockets).toHaveLength(0);
  h.stream.stop();
  expect(h.timers.size).toBe(0);
});

test('reconnects with a fresh ticket after a drop and ignores events of the old socket', async () => {
  const h = harness();
  h.stream.start();
  await h.flush();
  const first = h.sockets[0];
  first.open();
  // «Наживо» — лише після першого знімка: відкритий сокет ще не доводить підписки.
  expect(h.states).not.toContain('live');
  first.send({ type: 'snapshot', execution: summary('1') });
  expect(h.states).toContain('live');
  first.drop();
  expect(h.states.at(-1)).toBe('reconnecting');
  await h.advance(500);
  expect(h.tickets).toBe(2);
  const second = h.sockets[1];
  expect(second.ticket).toBe('t2');
  // Пізнє повідомлення старого сокета не застосовується.
  first.send({ type: 'snapshot', execution: summary('99', 'failed') });
  second.open();
  second.send({ type: 'snapshot', execution: summary('3', 'succeeded') });
  expect(h.snapshots.map((s) => s.revision)).toEqual(['1', '3']);
  h.stream.stop();
});

test('treats a silent socket as dead and reconnects after the watchdog interval', async () => {
  const h = harness();
  h.stream.start();
  await h.flush();
  h.sockets[0].open();
  await h.advance(WATCHDOG_MS - 1);
  expect(h.tickets).toBe(1);
  await h.advance(1);
  expect(h.sockets[0].closed).toBe(true);
  await h.advance(500);
  expect(h.tickets).toBe(2);
  h.stream.stop();
});

test('falls back to HTTP polling after three failed connections and stops polling when live again', async () => {
  let summaryRevision = 1;
  const h = harness({
    tickets: () => Promise.resolve({ ok: false, reason: 'retry' }),
    summaries: () =>
      Promise.resolve({
        ok: true,
        summary: summary(String(summaryRevision++), 'running'),
      }),
  });
  h.stream.start();
  await h.flush();
  await h.advance(250 + 500 + 1000);
  expect(h.states).toContain('polling');
  await h.advance(POLL_INTERVAL_MS * 2);
  expect(h.summaryCalls).toBeGreaterThanOrEqual(2);
  expect(h.snapshots.length).toBe(h.summaryCalls);
  h.stream.stop();
  const calls = h.summaryCalls;
  await h.advance(POLL_INTERVAL_MS * 5);
  expect(h.summaryCalls).toBe(calls);
});

test('treats close code 4401 as a revoked session and 4404 as a gone execution', async () => {
  const revoked = harness();
  revoked.stream.start();
  await revoked.flush();
  revoked.sockets[0].drop(4401);
  expect(revoked.expired).toBe(true);
  expect(revoked.timers.size).toBe(0);
  const gone = harness();
  gone.stream.start();
  await gone.flush();
  gone.sockets[0].drop(4404);
  expect(gone.states.at(-1)).toBe('gone');
  expect(gone.timers.size).toBe(0);
});

test('stops for good on a gone execution and hands an expired session to the page', async () => {
  const gone = harness({
    tickets: () => Promise.resolve({ ok: false, reason: 'gone' }),
  });
  gone.stream.start();
  await gone.flush();
  expect(gone.states.at(-1)).toBe('gone');
  expect(gone.timers.size).toBe(0);

  const session = harness({
    tickets: () => Promise.resolve({ ok: false, reason: 'session' }),
  });
  session.stream.start();
  await session.flush();
  expect(session.expired).toBe(true);
  expect(session.timers.size).toBe(0);
});

test('stop releases the socket, every timer and the pending ticket request', async () => {
  let release: (value: TicketResult) => void = () => undefined;
  const h = harness({
    tickets: () =>
      new Promise<TicketResult>((resolve) => {
        release = resolve;
      }),
  });
  h.stream.start();
  await h.flush();
  h.stream.stop();
  expect(h.aborts[0].aborted).toBe(true);
  release({ ok: true, ticket: 'late' });
  await h.flush();
  // Тикет, що прийшов після виходу зі сторінки, сокета не відкриває.
  expect(h.sockets).toHaveLength(0);
  expect(h.timers.size).toBe(0);

  const live = harness();
  live.stream.start();
  await live.flush();
  live.sockets[0].open();
  live.stream.stop();
  expect(live.sockets[0].closed).toBe(true);
  expect(live.sockets[0].onmessage).toBeNull();
  expect(live.timers.size).toBe(0);
});
