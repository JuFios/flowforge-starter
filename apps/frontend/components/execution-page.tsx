'use client';
import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import { apiRequest, goToLogin, describeRejection } from '@/lib/client-api';
import {
  ExecutionStream,
  StreamState,
  SocketLike,
} from '@/lib/execution-stream';
import { ExecutionSummary } from '@/lib/types';
import { Status } from './list-page';

export function ExecutionPage({ id }: { id: string }) {
  const [data, setData] = useState<ExecutionSummary>(),
    [state, setState] = useState<StreamState>('connecting'),
    [error, fail] = useState('');
  const [selected, select] = useState<string>(),
    [output, setOutput] = useState(''),
    [waiting, busy] = useState(false);
  const abort = useRef<AbortController>();
  const retryRequest = useRef<AbortController>();
  const [unresolvedCycle, rememberCycle] = useState<number>();
  const [resolvedCycle, markResolved] = useState<number>();
  useEffect(() => {
    const base = 'executions/' + id;
    const stream = new ExecutionStream(
      id,
      {
        async issueTicket(signal) {
          const r = await apiRequest<{ ticket: string }>(
            'POST',
            base + '/realtime-tickets',
            { signal },
          );
          if (r.kind === 'ok') return { ok: true, ticket: r.data.ticket };
          return {
            ok: false,
            reason:
              r.kind === 'session_expired'
                ? 'session'
                : r.kind === 'rejected' && r.status === 404
                  ? 'gone'
                  : 'retry',
            retryAfterMs:
              r.kind === 'rejected' && r.retryAfterSeconds
                ? r.retryAfterSeconds * 1000
                : undefined,
          };
        },
        async fetchSummary(signal) {
          const r = await apiRequest<ExecutionSummary>(
            'GET',
            base + '/summary',
            { signal },
          );
          return r.kind === 'ok'
            ? { ok: true, summary: r.data }
            : {
                ok: false,
                reason:
                  r.kind === 'session_expired'
                    ? 'session'
                    : r.kind === 'rejected' && r.status === 404
                      ? 'gone'
                      : 'retry',
                retryAfterMs:
                  r.kind === 'rejected' && r.retryAfterSeconds !== undefined
                    ? r.retryAfterSeconds * 1000
                    : undefined,
              };
        },
        openSocket(ticket) {
          return new WebSocket(
            (location.protocol === 'https:' ? 'wss://' : 'ws://') +
              location.host +
              '/realtime?ticket=' +
              encodeURIComponent(ticket),
          ) as unknown as SocketLike;
        },
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (h) => window.clearTimeout(h as number),
        now: () => performance.now(),
        random: Math.random,
      },
      {
        onSnapshot: setData,
        onState: (s) => {
          if (s !== 'stopped') setState(s);
        },
        onSessionExpired: goToLogin,
      },
    );
    stream.fetchInitialSummary();
    const online = () => stream.nudge();
    window.addEventListener('online', online);
    stream.start();
    return () => {
      window.removeEventListener('online', online);
      stream.stop();
      abort.current?.abort();
      retryRequest.current?.abort();
    };
  }, [id]);
  async function detail(path: string) {
    abort.current?.abort();
    if (selected === path) {
      select(undefined);
      return;
    }
    const c = new AbortController();
    abort.current = c;
    select(path);
    setOutput('Завантаження…');
    const r = await apiRequest<{ output: unknown }>(
      'GET',
      'executions/' + id + '/' + path,
      { signal: c.signal },
    );
    if (c.signal.aborted) return;
    if (r.kind === 'session_expired') return goToLogin();
    setOutput(
      r.kind === 'ok'
        ? JSON.stringify(r.data.output, null, 2)
        : r.kind === 'rejected'
          ? describeRejection(r)
          : 'Зв’язок перервано. Повторіть читання.',
    );
  }
  const failedCycle =
    data?.status === 'failed' &&
    Number.isInteger(data.terminalCycles) &&
    data.terminalCycles > (resolvedCycle ?? -1)
      ? data.terminalCycles
      : undefined;
  const retryCycle = unresolvedCycle ?? failedCycle;
  async function retry() {
    if (retryCycle === undefined || retryRequest.current) return;
    const controller = new AbortController();
    retryRequest.current = controller;
    busy(true);
    fail('');
    try {
      const r = await apiRequest(
        'POST',
        `executions/${id}/retry?expectedTerminalCycle=${retryCycle}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (r.kind === 'session_expired') return goToLogin();
      if (
        r.kind === 'ok' ||
        (r.kind === 'rejected' && r.error === 'retry_cycle_conflict')
      ) {
        markResolved(retryCycle);
        rememberCycle(undefined);
      }
      if (r.kind === 'rejected') {
        if (r.status >= 500 || r.status === 429 || r.status === 408)
          rememberCycle(retryCycle);
        fail(describeRejection(r));
      }
      if (r.kind === 'network') {
        rememberCycle(retryCycle);
        fail('Результат повтору невідомий. Повторіть попередній запит.');
      }
    } finally {
      retryRequest.current = undefined;
      if (!controller.signal.aborted) busy(false);
    }
  }
  const connection = {
    connecting: 'Підключення…',
    live: 'Наживо',
    reconnecting: 'Відновлення з’єднання…',
    polling: 'Оновлення через HTTP',
    gone: 'Виконання недоступне',
    stopped: '',
  }[state];
  return (
    <>
      <Link href="/executions" className="heading-link">
        ← Виконання
      </Link>
      <div className="toolbar page-heading">
        <h1>{data?.workflowName ?? 'Виконання'}</h1>
        <span
          className={state === 'live' ? 'connection live' : 'connection'}
          role="status"
        >
          {connection}
        </span>
      </div>
      {state !== 'gone' && data ? (
        <>
          <section className="panel execution-overview">
            <div className="toolbar">
              <Status value={data.status} />
              <time dateTime={data.createdAt}>
                {new Date(data.createdAt).toLocaleString('uk-UA')}
              </time>
            </div>
            <dl className="facts">
              <div>
                <dt>Ідентифікатор</dt>
                <dd>
                  <code>{data.id}</code>
                </dd>
              </div>
              <div>
                <dt>Версія процесу</dt>
                <dd>{data.workflowVersion ?? '—'}</dd>
              </div>
            </dl>
            {data.error && <p role="alert">{data.error}</p>}
            {retryCycle !== undefined && (
              <button disabled={waiting} onClick={retry}>
                {unresolvedCycle === undefined
                  ? 'Повторити виконання'
                  : 'Повторити попередній запит'}
              </button>
            )}
            {error && <p role="alert">{error}</p>}
          </section>
          <h2>Кроки виконання</h2>
          <ol className="execution-steps">
            {data.plan.map((step, i) => {
              const run = data.steps.find((s) => s.stepIndex === i);
              const path = 'steps/' + i;
              return (
                <li className="panel execution-step" key={step.id}>
                  <div className="toolbar">
                    <strong>
                      <span className="step-index" aria-hidden="true">
                        {i + 1}
                      </span>{' '}
                      {step.id}
                    </strong>
                    <span
                      className={
                        'status ' +
                        (run?.status === 'succeeded'
                          ? 'success'
                          : (run?.status ?? ''))
                      }
                    >
                      {run
                        ? run.status === 'succeeded'
                          ? 'Завершено'
                          : run.status === 'failed'
                            ? 'Помилка'
                            : 'Виконується'
                        : 'Очікує'}
                    </span>
                  </div>
                  <small>
                    {step.type}
                    {run ? ' · Спроб: ' + run.attempts : ''}
                  </small>
                  {run?.error && <p>{run.error}</p>}
                  {run?.outputBytes != null && (
                    <button
                      className="plain result-toggle"
                      onClick={() => detail(path)}
                      aria-expanded={selected === path}
                    >
                      Результат кроку
                    </button>
                  )}
                  {selected === path && <pre>{output}</pre>}
                </li>
              );
            })}
          </ol>
          {data.outputBytes != null && (
            <section className="panel">
              <button
                className="secondary"
                onClick={() => detail('output')}
                aria-expanded={selected === 'output'}
              >
                Результат виконання
              </button>
              {selected === 'output' && <pre>{output}</pre>}
            </section>
          )}
        </>
      ) : (
        <p role="status">
          {state === 'gone'
            ? 'Виконання не знайдено або доступ завершився.'
            : 'Очікування даних…'}
        </p>
      )}
    </>
  );
}
