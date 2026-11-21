import { ConflictException } from '@nestjs/common';

/**
 * Пара ключів підпису з ротацією без простою (вхідні webhook-и 3.3.7, вихідні сповіщення 3.3.9):
 * `current` діяв до останньої ротації, `next` створено нею; обидва чинні, доки `current` не
 * відкличуть. Одні правила для обох наборів ключів — тут; SQL кожного набору — у його сервісі.
 */
export interface SigningKeyPair {
  current: string;
  next: string | null;
}

export interface SigningKeyView {
  id: string;
  role: 'current' | 'next';
}

export function keyViews(pair: SigningKeyPair): SigningKeyView[] {
  const views: SigningKeyView[] = [{ id: pair.current, role: 'current' }];
  if (pair.next) views.push({ id: pair.next, role: 'next' });
  return views;
}

/** Ротація можлива лише з одним активним ключем. */
export function assertCanRotate(pair: SigningKeyPair): void {
  if (pair.next) throw new ConflictException('Уже є два активні ключі');
}

/**
 * Що робить відкликання ключа `id`: `promote` — відкликається `current`, `next` стає `current`;
 * `drop-next` — відкликається `next`; `none` — такого ключа вже немає (повтор нічого не змінює).
 * Останній активний ключ не відкликається.
 */
export function planRevoke(
  pair: SigningKeyPair,
  id: string,
): 'promote' | 'drop-next' | 'none' {
  if (pair.current === id) {
    if (!pair.next)
      throw new ConflictException('Потрібен хоча б один активний ключ');
    return 'promote';
  }
  return pair.next === id ? 'drop-next' : 'none';
}
