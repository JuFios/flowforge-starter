'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
export function Navigation() {
  const path = usePathname();
  const [error, fail] = useState('');
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    const channel = new BroadcastChannel('ff-session');
    channel.onmessage = () => {
      if (location.pathname !== '/login') location.replace('/login');
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener('pageshow', restore);
    return () => {
      channel.close();
      window.removeEventListener('pageshow', restore);
    };
  }, []);
  async function logout() {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    fail('');
    try {
      const r = await fetch('/api/session', {
        method: 'DELETE',
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const retry = Number(r.headers.get('retry-after'));
        fail(
          r.status === 429 && retry > 0
            ? `Спробуйте вийти через ${retry} с.`
            : 'Не вдалося завершити сесію. Повторіть вихід.',
        );
        return;
      }
      const channel = new BroadcastChannel('ff-session');
      channel.postMessage('changed');
      channel.close();
      location.replace('/login');
    } catch {
      fail('Не вдалося завершити сесію. Повторіть вихід.');
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <header className="site-header">
      <div className="nav">
        <Link href="/workflows" className="brand">
          <span className="brand-mark" aria-hidden="true">
            ↳
          </span>
          FlowForge
        </Link>
        {path !== '/login' && (
          <>
            <nav aria-label="Головна навігація">
              <Link
                aria-current={
                  path.startsWith('/workflows') ? 'page' : undefined
                }
                href="/workflows"
              >
                Процеси
              </Link>
              <Link
                aria-current={
                  path.startsWith('/executions') ? 'page' : undefined
                }
                href="/executions"
              >
                Виконання
              </Link>
            </nav>
            <button
              className="plain sign-out"
              onClick={logout}
              disabled={pending}
            >
              {pending ? 'Вихід…' : 'Вийти'}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="nav-error" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}
