'use client';
import { useEffect, useState, useRef, FormEvent } from 'react';
import Link from 'next/link';
import { apiRequest, goToLogin, describeRejection } from '@/lib/client-api';
import {
  createWorkflowSchema,
  updateWorkflowSchema,
  LIMITS,
  HTTP_METHODS,
  MISSED_RUN_POLICIES,
} from '@/lib/workflow-schema';
import type { WorkflowView, StepView } from '@/lib/types';

type Header = {
  name: string;
  value: string;
  stored: boolean;
  mode: 'keep' | 'replace' | 'remove';
};
type Draft = {
  key: string;
  id: string;
  originalId: string;
  type: StepView['type'];
  url: string;
  method: string;
  body: string;
  expr: string;
  message: string;
  ms: string;
  headers: Header[];
};
function draft(step?: StepView): Draft {
  const id = step?.id ?? 'step1';
  const http = step?.type === 'http' ? step : undefined;
  return {
    key: crypto.randomUUID(),
    id,
    originalId: id,
    type: step?.type ?? 'log',
    url: http?.url ?? '',
    method: http?.method ?? 'GET',
    body: http?.body ?? '',
    expr: step?.type === 'transform' ? step.expr : '',
    message: step?.type === 'log' ? step.message : '',
    ms: step?.type === 'delay' ? String(step.ms) : '1000',
    headers: Object.keys(http?.headers ?? {}).map((name) => ({
      name,
      value: '',
      stored: true,
      mode: 'keep',
    })),
  };
}
function payload(step: Draft) {
  const { id, type } = step;
  switch (type) {
    case 'http':
      return {
        id,
        type,
        url: step.url,
        method: step.method,
        headers: Object.fromEntries(
          step.headers
            .filter((h) => h.mode !== 'remove')
            .map((h) => [h.name, h.mode === 'keep' ? { keep: true } : h.value]),
        ),
        ...(step.body ? { body: step.body } : {}),
      };
    case 'log':
      return { id, type, message: step.message };
    case 'delay':
      return { id, type, ms: step.ms.trim() ? Number(step.ms) : null };
    case 'transform':
      return { id, type, expr: step.expr };
  }
}

export function WorkflowEditor({ workflow }: { workflow?: WorkflowView }) {
  const [name, setName] = useState(workflow?.name ?? ''),
    [steps, setSteps] = useState(() =>
      workflow ? workflow.steps.map(draft) : [draft()],
    ),
    [cron, setCron] = useState(workflow?.cron ?? ''),
    [timezone, setZone] = useState(workflow?.timezone ?? 'UTC'),
    [enabled, enable] = useState(workflow?.enabled ?? true),
    [policy, setPolicy] = useState(workflow?.missedRunPolicy ?? 'skip'),
    [issues, errors] = useState<Record<string, string>>({}),
    [saving, busy] = useState(false),
    [message, note] = useState(''),
    [dirty, setDirty] = useState(false),
    [unknown, uncertain] = useState(false);
  const [zones, setZones] = useState<string[]>([]);
  const saved = useRef(false);
  const lock = useRef(false);
  useEffect(() => {
    setZones(Intl.supportedValuesOf('timeZone'));
  }, []);
  useEffect(() => {
    if (!dirty) return;
    function leave(e: BeforeUnloadEvent) {
      if (saved.current) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  const patch = (i: number, update: Partial<Draft>) => {
    setDirty(true);
    setSteps((old) => old.map((s, k) => (i === k ? { ...s, ...update } : s)));
  };
  function move(i: number, by: number) {
    const next = steps.slice();
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setSteps(next);
    setDirty(true);
  }
  const errorFor = (path: string) =>
    issues[path] ? (
      <span className="form-errors" id={'err-' + path}>
        {issues[path]}
      </span>
    ) : null;
  const attrs = (path: string) => ({
    'aria-invalid': !!issues[path],
    'aria-describedby': issues[path] ? 'err-' + path : undefined,
  });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (lock.current || unknown) return;
    note('');
    const body = {
      name,
      steps: steps.map(payload),
      enabled,
      cron: cron.trim() || null,
      timezone,
      missedRunPolicy: policy,
    };
    const parsed = (
      workflow ? updateWorkflowSchema : createWorkflowSchema
    ).safeParse(body);
    const invalid: Record<string, string> = {};
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        invalid[issue.path.join('.')] = issue.message;
    steps.forEach((s, i) => {
      if (s.type !== 'http') return;
      const names = new Set<string>();
      for (const h of s.headers.filter((h) => h.mode !== 'remove')) {
        const key = h.name.toLowerCase();
        if (names.has(key))
          invalid['steps.' + i + '.headers'] =
            'Назви заголовків мають бути унікальні';
        names.add(key);
        if (h.mode === 'keep' && s.originalId !== s.id)
          invalid['steps.' + i + '.headers'] =
            'Після зміни ID введіть збережені значення повторно.';
      }
    });
    errors(invalid);
    if (Object.keys(invalid).length) {
      note(Object.values(invalid)[0]);
      return;
    }
    lock.current = true;
    busy(true);
    try {
      const r = await apiRequest<WorkflowView>(
        workflow ? 'PATCH' : 'POST',
        workflow ? 'workflows/' + workflow.id : 'workflows',
        { body },
      );
      if (r.kind === 'ok') {
        setDirty(false);
        saved.current = true;
        location.assign('/workflows/' + r.data.id);
        return;
      }
      if (r.kind === 'session_expired') {
        goToLogin();
        return;
      }
      if (r.kind === 'network') {
        if (!workflow) uncertain(true);
        note(
          'Результат збереження невідомий. Перевірте поточний стан процесу.',
        );
        return;
      }
      if (r.kind === 'rejected') {
        for (const text of r.messages) {
          const p =
            /^(steps\[\d+\](?:\.[\w-]+)*|name|timezone|cron|enabled|missedRunPolicy)/.exec(
              text,
            )?.[1];
          if (text.startsWith('schedule:'))
            invalid[/zone/i.test(text) ? 'timezone' : 'cron'] = text;
          else if (p) invalid[p.replace(/\[(\d+)\]/g, '.$1')] = text;
        }
        errors(invalid);
        note(describeRejection(r));
      }
    } finally {
      busy(false);
      lock.current = false;
    }
  }
  return (
    <form onSubmit={save} onChange={() => setDirty(true)} noValidate>
      <section className="panel">
        <label>
          Назва процесу
          <input
            {...attrs('name')}
            value={name}
            maxLength={LIMITS.maxNameLength}
            onChange={(e) => setName(e.target.value)}
          />
          {errorFor('name')}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => enable(e.target.checked)}
          />
          Увімкнено
        </label>
      </section>
      <h2>Кроки</h2>
      {steps.map((s, i) => {
        const base = 'steps.' + i;
        const text = (
          field: 'id' | 'url' | 'body' | 'message' | 'expr' | 'ms',
          title: string,
          area = false,
        ) => (
          <label>
            {title}
            {area ? (
              <textarea
                {...attrs(base + '.' + field)}
                value={s[field]}
                onChange={(e) => patch(i, { [field]: e.target.value })}
              />
            ) : (
              <input
                {...attrs(base + '.' + field)}
                value={s[field]}
                onChange={(e) => patch(i, { [field]: e.target.value })}
              />
            )}{' '}
            {errorFor(base + '.' + field)}
          </label>
        );
        const updateHeader = (j: number, part: Partial<Header>) =>
          patch(i, {
            headers: s.headers.map((h, k) => (j === k ? { ...h, ...part } : h)),
          });
        return (
          <fieldset key={s.key}>
            <legend>Крок {i + 1}</legend>
            <div className="actions">
              <button
                type="button"
                className="secondary"
                aria-label={'Крок ' + (i + 1) + ' вище'}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="secondary"
                aria-label={'Крок ' + (i + 1) + ' нижче'}
                disabled={i === steps.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="plain"
                disabled={steps.length === 1}
                onClick={() => {
                  setDirty(true);
                  setSteps(steps.filter((_, j) => j !== i));
                }}
              >
                Прибрати крок
              </button>
            </div>
            {text('id', 'ID кроку')}
            <label>
              Тип кроку
              <select
                value={s.type}
                onChange={(e) =>
                  patch(i, { type: e.target.value as Draft['type'] })
                }
              >
                {['http', 'transform', 'log', 'delay'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            {s.type === 'log' ? (
              text('message', 'Повідомлення', true)
            ) : s.type === 'transform' ? (
              text('expr', 'Вираз JSONata', true)
            ) : s.type === 'delay' ? (
              text('ms', 'Затримка, мс')
            ) : (
              <>
                {text('url', 'URL запиту')}
                <label>
                  Метод
                  <select
                    value={s.method}
                    onChange={(e) => patch(i, { method: e.target.value })}
                  >
                    {HTTP_METHODS.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </label>
                {!['GET', 'HEAD'].includes(s.method) &&
                  text('body', 'Тіло HTTP-запиту', true)}
                <h3>Заголовки</h3>
                {s.headers.map((h, j) => (
                  <div className="header-pair" key={j}>
                    <label>
                      Назва заголовка
                      <input
                        value={h.name}
                        disabled={h.stored}
                        onChange={(e) =>
                          updateHeader(j, { name: e.target.value })
                        }
                      />
                    </label>
                    {h.mode === 'replace' ? (
                      <label>
                        Значення
                        <input
                          type="password"
                          autoComplete="off"
                          value={h.value}
                          onChange={(e) =>
                            updateHeader(j, { value: e.target.value })
                          }
                        />
                      </label>
                    ) : (
                      <span>
                        {h.mode === 'keep' ? 'Збережено' : 'Буде видалено'}
                      </span>
                    )}
                    {h.mode !== 'replace' && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => updateHeader(j, { mode: 'replace' })}
                      >
                        Замінити
                      </button>
                    )}
                    {h.stored && h.mode !== 'keep' && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          updateHeader(j, { mode: 'keep', value: '' })
                        }
                      >
                        Відновити збережене
                      </button>
                    )}
                    {h.mode !== 'remove' && (
                      <button
                        type="button"
                        className="plain"
                        onClick={() =>
                          h.stored
                            ? updateHeader(j, { mode: 'remove', value: '' })
                            : patch(i, {
                                headers: s.headers.filter((_, k) => k !== j),
                              })
                        }
                      >
                        Видалити
                      </button>
                    )}
                  </div>
                ))}
                {errorFor(base + '.headers')}
                {Object.entries(issues)
                  .filter(([k]) => k.startsWith(base + '.headers.'))
                  .map(([k, v]) => (
                    <p key={k} role="alert">
                      {v}
                    </p>
                  ))}
                <button
                  className="secondary"
                  type="button"
                  disabled={s.headers.length >= LIMITS.maxHeaders}
                  onClick={() =>
                    patch(i, {
                      headers: [
                        ...s.headers,
                        { name: '', value: '', stored: false, mode: 'replace' },
                      ],
                    })
                  }
                >
                  Додати заголовок
                </button>
              </>
            )}
          </fieldset>
        );
      })}
      <button
        type="button"
        className="secondary"
        disabled={steps.length >= LIMITS.maxSteps}
        onClick={() => {
          const s = draft();
          let n = steps.length + 1;
          while (steps.some((x) => x.id === 'step' + n)) n++;
          s.id = 'step' + n;
          setSteps([...steps, s]);
          setDirty(true);
        }}
      >
        Додати крок
      </button>
      <h2>Розклад</h2>
      <section className="panel">
        <label>
          Cron
          <input
            placeholder="Без розкладу"
            {...attrs('cron')}
            value={cron}
            onChange={(e) => setCron(e.target.value)}
          />
          {errorFor('cron')}
        </label>
        <label>
          Часова зона
          <input
            list="timezones"
            {...attrs('timezone')}
            value={timezone}
            onChange={(e) => setZone(e.target.value)}
          />
          {errorFor('timezone')}
        </label>
        <datalist id="timezones">
          <option>UTC</option>
          {zones.map((z) => (
            <option key={z}>{z}</option>
          ))}
        </datalist>
        <label>
          Пропущені запуски
          <select
            value={policy}
            onChange={(e) => setPolicy(e.target.value as typeof policy)}
          >
            {MISSED_RUN_POLICIES.map((p) => (
              <option key={p} value={p}>
                {
                  {
                    skip: 'Пропустити',
                    run_once: 'Виконати один раз',
                    run_all: 'Виконати всі',
                  }[p]
                }
              </option>
            ))}
          </select>
        </label>
      </section>
      {message && <p role="alert">{message}</p>}
      {unknown && <Link href="/workflows">Перевірити список процесів</Link>}
      <div className="actions">
        <button disabled={saving || unknown}>
          {saving ? 'Збереження…' : 'Зберегти процес'}
        </button>
        <Link href={workflow ? '/workflows/' + workflow.id : '/workflows'}>
          Скасувати
        </Link>
      </div>
    </form>
  );
}
