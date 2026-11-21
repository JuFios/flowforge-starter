import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { safeEqual } from './safe-equal';

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

/** Результат ротації: ID ключа `next`; `created: false` — повтор уже прийнятої ротації. */
export interface RotationResult {
  id: string;
  role: 'next';
  created: boolean;
}

interface StoredKey {
  id: string;
  secret: string;
}

/**
 * Ротація з секретом, який передав клієнт (ТЗ 4: сервер секретів не видає). Той самий секрет, що
 * вже стоїть у `next`, — повтор після втраченої відповіді: повертаємо той самий ID. Інакше ротація
 * можлива лише з одним активним ключем, і новий секрет має відрізнятися від чинного.
 */
export function planRotate(
  current: StoredKey,
  next: StoredKey | null,
  secret: string,
): RotationResult {
  if (next && safeEqual(secret, next.secret))
    return { id: next.id, role: 'next', created: false };
  if (next) throw new ConflictException('Уже є два активні ключі');
  if (safeEqual(secret, current.secret))
    throw new ConflictException('Новий секрет має відрізнятися від чинного');
  return { id: randomUUID(), role: 'next', created: true };
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
