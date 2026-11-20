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
    const initial = new AbortController();
    void apiRequest<ExecutionSummary>('GET', base + '/summary', {
      signal: initial.signal,
    }).then((r) => {
      if (!initial.signal.aborted && r.kind === 'ok') stream.seed(r.data);
    });
    const online = () => stream.nudge();
    window.addEventListener('online', online);
    stream.start();
    return () => {
      window.removeEventListener('online', online);
      initial.abort();
      stream.stop();
      abort.current?.abort();
    };
  }, [id]);
  async function detail(path: string) {
    abort.current?.abort();
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
  async function retry() {
    busy(true);
    fail('');
    const r = await apiRequest('POST', 'executions/' + id + '/retry');
    busy(false);
    if (r.kind === 'session_expired') return goToLogin();
    if (r.kind === 'rejected') fail(describeRejection(r));
    if (r.kind === 'network') fail(r.message);
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
      <div className="toolbar">
        <h1>{data?.workflowName ?? 'Виконання'}</h1>
        <span role="status">{connection}</span>
      </div>
      {state !== 'gone' && data ? (
        <>
          <section className="panel">
            <div className="toolbar">
              <Status value={data.status} />
              <time>{new Date(data.createdAt).toLocaleString('uk-UA')}</time>
            </div>
            <p>
              {data.id} · Версія {data.workflowVersion ?? '—'}
            </p>
            {data.error && <p role="alert">{data.error}</p>}
            {data.status === 'failed' && (
              <button disabled={waiting} onClick={retry}>
                Повторити виконання
              </button>
            )}
            {error && <p role="alert">{error}</p>}
          </section>
          <h2>Кроки виконання</h2>
          {data.plan.map((step, i) => {
            const run = data.steps.find((s) => s.stepIndex === i);
            const path = 'steps/' + i;
            return (
              <section className="panel" key={i}>
                <div className="toolbar">
                  <strong>
                    {i + 1}. {step.id}
                  </strong>
                  <span>
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
                  <button className="plain" onClick={() => detail(path)}>
                    Результат кроку
                  </button>
                )}
                {selected === path && <pre>{output}</pre>}
              </section>
            );
          })}
          {data.outputBytes != null && (
            <section className="panel">
              <button className="secondary" onClick={() => detail('output')}>
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
