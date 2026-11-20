'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { WorkflowView } from '@/lib/types';
import { apiRequest, describeRejection, goToLogin } from '@/lib/client-api';
import { parseRunInput } from '@/lib/workflow-schema';
import { WorkflowEditor } from './workflow-editor';
export function WorkflowDetail({ wf }: { wf: WorkflowView }) {
  const [editing, edit] = useState(false),
    [deleting, confirm] = useState(false),
    [input, setInput] = useState('{}'),
    [message, note] = useState(''),
    [pending, busy] = useState(false);
  const key = useRef<string>(),
    locked = useRef(false);
  async function run() {
    if (locked.current) return;
    const parsed = parseRunInput(input);
    if (!parsed.ok) {
      note(parsed.error);
      return;
    }
    key.current ??= crypto.randomUUID();
    locked.current = true;
    busy(true);
    try {
      const r = await apiRequest<{ id: string }>(
        'POST',
        'workflows/' + wf.id + '/run',
        { body: parsed.value, idempotencyKey: key.current },
      );
      if (r.kind === 'ok') {
        location.assign('/executions/' + r.data.id);
        return;
      }
      if (r.kind === 'session_expired') return goToLogin();
      if (r.kind === 'rejected') {
        if (r.status < 500) key.current = undefined;
        note(describeRejection(r));
      } else note('Результат запуску невідомий. Повторіть з тим самим ключем.');
    } finally {
      locked.current = false;
      busy(false);
    }
  }
  async function remove() {
    busy(true);
    try {
      const r = await apiRequest('DELETE', 'workflows/' + wf.id);
      if (r.kind === 'ok' || (r.kind === 'rejected' && r.status === 404))
        location.assign('/workflows');
      else if (r.kind === 'session_expired') goToLogin();
      else
        note(
          r.kind === 'rejected'
            ? describeRejection(r)
            : 'Не вдалося підтвердити видалення.',
        );
    } finally {
      busy(false);
    }
  }
  return (
    <>
      <Link className="heading-link" href="/workflows">
        ← Процеси
      </Link>
      <div className="toolbar">
        <h1>{wf.name}</h1>
        {!editing && (
          <button className="secondary" onClick={() => edit(true)}>
            Редагувати
          </button>
        )}
      </div>
      {editing ? (
        <WorkflowEditor workflow={wf} />
      ) : (
        <>
          <section className="panel">
            <div className="toolbar">
              <strong>Версія {wf.version}</strong>
              <span className="status">
                {wf.enabled ? 'Увімкнено' : 'Вимкнено'}
              </span>
            </div>
            <p>{wf.cron ? wf.cron + ' · ' + wf.timezone : 'Без розкладу'}</p>
            {wf.scheduleError && <p role="alert">{wf.scheduleError}</p>}
            {wf.scheduleBlockedSince && (
              <p>
                Заблоковано з{' '}
                {new Date(wf.scheduleBlockedSince).toLocaleString('uk-UA')}
              </p>
            )}
            {wf.nextFireAt && (
              <p>
                Наступний запуск{' '}
                {new Date(wf.nextFireAt).toLocaleString('uk-UA')}
              </p>
            )}
            <ol>
              {wf.steps.map((s) => (
                <li key={s.id}>
                  {s.id} · {s.type}
                </li>
              ))}
            </ol>
            <Link href={'/executions?workflowId=' + wf.id}>
              Виконання цього процесу
            </Link>
          </section>
          <section className="panel">
            <h2>Запуск процесу</h2>
            <label>
              Вхідні дані (JSON)
              <textarea
                value={input}
                onChange={(e) => {
                  key.current = undefined;
                  setInput(e.target.value);
                }}
                disabled={pending}
              />
            </label>
            <button onClick={run} disabled={pending}>
              Запустити
            </button>
          </section>
          <div className="actions">
            {deleting ? (
              <>
                <span>Видалити «{wf.name}»?</span>
                <button className="danger" onClick={remove} disabled={pending}>
                  Підтвердити видалення
                </button>
                <button className="secondary" onClick={() => confirm(false)}>
                  Скасувати
                </button>
              </>
            ) : (
              <button className="danger" onClick={() => confirm(true)}>
                Видалити процес
              </button>
            )}
          </div>
          {message && <p role="alert">{message}</p>}
        </>
      )}
    </>
  );
}
