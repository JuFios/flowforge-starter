'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { WorkflowView } from '@/lib/types';
import { apiRequest, describeRejection, goToLogin } from '@/lib/client-api';
import { parseRunInput } from '@/lib/workflow-schema';
import { WorkflowEditor } from './workflow-editor';

interface RunIntent {
  key: string;
  source: string;
  uncertain: boolean;
}

export function WorkflowDetail({ wf }: { wf: WorkflowView }) {
  const router = useRouter();
  const [editing, edit] = useState(false),
    [deleting, confirm] = useState(false),
    [input, setInput] = useState('{}'),
    [message, note] = useState(''),
    [pending, busy] = useState(false);
  const [unresolvedRun, rememberRun] = useState<RunIntent>();
  const locked = useRef(false);
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
    let intent = unresolvedRun;
    if (!intent) {
      const parsed = parseRunInput(input);
      if (!parsed.ok) {
        note(parsed.error);
        return;
      }
      intent = {
        key: crypto.randomUUID(),
        source: parsed.source,
        uncertain: false,
      };
    }
    note('');
    locked.current = true;
    busy(true);
    try {
      const r = await apiRequest<{ id: string }>(
        'POST',
        'workflows/' + wf.id + '/run',
        { rawJson: intent.source, idempotencyKey: intent.key },
      );
      if (r.kind === 'ok') {
        rememberRun(undefined);
        location.assign('/executions/' + r.data.id);
        return;
      }
      if (r.kind === 'session_expired') return goToLogin();
      if (r.kind === 'rejected') {
        if (r.status >= 500 || r.status === 408)
          rememberRun({ ...intent, uncertain: true });
        else if (intent.uncertain || r.status === 429) rememberRun(intent);
        else rememberRun(undefined);
        note(describeRejection(r));
      } else {
        rememberRun({ ...intent, uncertain: true });
        note('Результат запуску невідомий. Повторіть попередній запуск.');
      }
    } finally {
      locked.current = false;
      busy(false);
    }
  }
  function abandonRun() {
    if (
      locked.current ||
      !window.confirm(
        'Попередній запуск міг створити виконання. Припинити його відновлення?',
      )
    )
      return;
    rememberRun(undefined);
    note('');
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
                    onChange={(e) => setInput(e.target.value)}
                    disabled={pending}
                  />
                </label>
                {unresolvedRun && (
                  <p>Повтор використає вхідні дані попереднього запуску.</p>
                )}
                <button disabled={pending}>
                  {unresolvedRun ? 'Повторити попередній запуск' : 'Запустити'}
                </button>
                {unresolvedRun && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={abandonRun}
                    disabled={pending}
                  >
                    Припинити відновлення
                  </button>
                )}
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
