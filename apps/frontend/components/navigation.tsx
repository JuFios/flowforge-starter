'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
export function Navigation() {
  const path = usePathname();
  const [error, fail] = useState('');
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
    try {
      const r = await fetch('/api/session', {
        method: 'DELETE',
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw Error();
      const channel = new BroadcastChannel('ff-session');
      channel.postMessage('changed');
      channel.close();
      location.replace('/login');
    } catch {
      fail('Не вдалося завершити сесію. Повторіть вихід.');
    }
  }
  return (
    <header>
      <div className="nav">
        <Link href="/workflows" className="brand">
          <span className="brand-mark" aria-hidden="true">
            ↳
          </span>
          FlowForge
        </Link>
        {path !== '/login' && (
          <>
            <nav>
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
            <button className="plain" onClick={logout}>
              Вийти
            </button>
          </>
        )}
        {error && <span role="alert">{error}</span>}
      </div>
    </header>
  );
}
