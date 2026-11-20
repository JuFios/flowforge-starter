'use client';
import { useRef, useState, FormEvent } from 'react';
export default function Login() {
  const [key, setKey] = useState(''),
    [pending, busy] = useState(false),
    [error, fail] = useState('');
  const lock = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    busy(true);
    fail('');
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const data = await response.json();
        fail(data.message ?? 'Не вдалося увійти');
        return;
      }
      setKey('');
      const channel = new BroadcastChannel('ff-session');
      channel.postMessage('changed');
      channel.close();
      const next =
        new URLSearchParams(location.search).get('next') || '/workflows';
      const target = new URL(next, location.origin);
      location.replace(
        target.origin === location.origin &&
          /^\/(workflows|executions)(\/|$)/.test(target.pathname)
          ? target.href
          : '/workflows',
      );
    } catch {
      fail(
        'Не вдалося зв’язатися з сервером. Перевірте з’єднання й повторіть.',
      );
    } finally {
      lock.current = false;
      busy(false);
    }
  }
  return (
    <section className="login panel">
      <h1>Вхід до FlowForge</h1>
      <p>Введіть API-ключ свого тенанта.</p>
      <form onSubmit={submit}>
        <label>
          API-ключ
          <input
            aria-invalid={!!error}
            aria-describedby={error ? 'login-error' : undefined}
            type="password"
            autoComplete="off"
            maxLength={256}
            required
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {error && (
          <p className="notice" role="alert" id="login-error">
            {error}
          </p>
        )}
        <button disabled={pending}>{pending ? 'Вхід…' : 'Увійти'}</button>
      </form>
    </section>
  );
}
