'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { WorkflowView } from '@/lib/types';
import { apiRequest, describeRejection, goToLogin } from '@/lib/client-api';
import { parseRunInput } from '@/lib/workflow-schema';
import { WorkflowEditor } from './workflow-editor';
export function WorkflowDetail({ wf }: { wf: WorkflowView }) {
  const router = useRouter();
  const [editing, edit] = useState(false),
    [deleting, confirm] = useState(false),
    [input, setInput] = useState('{}'),
    [message, note] = useState(''),
    [pending, busy] = useState(false);
  const key = useRef<string>(),
    locked = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const cancelEdit = useRef(false);
  useEffect(() => {
    if (!editing && cancelEdit.current) {
      editButton.current?.focus();
      cancelEdit.current = false;
    }
  }, [editing]);
  async function run() {
    if (locked.current) return;
    const parsed = parseRunInput(input);
    if (!parsed.ok) {
      note(parsed.error);
      return;
    }
    key.current ??= crypto.randomUUID();
    note('');
    locked.current = true;
    busy(true);
    try {
      const r = await apiRequest<{ id: string }>(
        'POST',
        'workflows/' + wf.id + '/run',
        { rawJson: parsed.source, idempotencyKey: key.current },
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
    if (locked.current) return;
    locked.current = true;
    busy(true);
    note('');
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
      locked.current = false;
      busy(false);
    }
  }
  return (
    <>
      <Link className="heading-link" href="/workflows">
        ← Процеси
      </Link>
      <div className="toolbar page-heading">
        <h1>{wf.name}</h1>
        {!editing && (
          <button
            ref={editButton}
            className="secondary"
            disabled={pending}
            onClick={() => edit(true)}
          >
            Редагувати
          </button>
        )}
      </div>
      {editing ? (
        <WorkflowEditor
          workflow={wf}
          onCancel={(refresh) => {
            cancelEdit.current = true;
            edit(false);
            if (refresh) router.refresh();
          }}
        />
      ) : (
        <>
          <div className="detail-grid">
            <section className="panel overview">
              <div className="toolbar">
                <h2>Процес</h2>
                <span className={'status' + (wf.enabled ? ' success' : '')}>
                  {wf.enabled ? 'Увімкнено' : 'Вимкнено'}
                </span>
              </div>
              <dl className="facts">
                <div>
                  <dt>Версія</dt>
                  <dd>{wf.version}</dd>
                </div>
                <div>
                  <dt>Розклад</dt>
                  <dd>
                    {wf.cron ? (
                      <>
                        <code>{wf.cron}</code> · {wf.timezone}
                      </>
                    ) : (
                      'Без розкладу'
                    )}
                  </dd>
                </div>
              </dl>
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
                  {new Date(wf.nextFireAt).toLocaleString('uk-UA', {
                    timeZone: wf.timezone,
                    timeZoneName: 'short',
                  })}
                </p>
              )}
              {wf.enabled && wf.cron && !wf.nextFireAt && !wf.scheduleError && (
                <p>Наступний запуск розраховується</p>
              )}
              <h3>Кроки</h3>
              <ol className="step-list">
                {wf.steps.map((s) => (
                  <li key={s.id}>
                    <code>{s.id}</code>
                    <span>{s.type}</span>
                  </li>
                ))}
              </ol>
              <Link href={'/executions?workflowId=' + wf.id}>
                Виконання цього процесу
              </Link>
            </section>
            <section className="panel run-panel">
              <h2>Запуск процесу</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run();
                }}
              >
                <label>
                  Вхідні дані (JSON)
                  <textarea
                    className="code-input"
                    spellCheck={false}
                    value={input}
                    onChange={(e) => {
                      key.current = undefined;
                      setInput(e.target.value);
                    }}
                    disabled={pending}
                  />
                </label>
                <button disabled={pending}>Запустити</button>
              </form>
            </section>
          </div>
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
              <button
                className="danger"
                onClick={() => confirm(true)}
                disabled={pending}
              >
                Видалити процес
              </button>
            )}
          </div>
          {message && (
            <p className="notice" role="alert">
              {message}
            </p>
          )}
        </>
      )}
    </>
  );
}
