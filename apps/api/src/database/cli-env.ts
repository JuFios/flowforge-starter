import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Завантажує `.env` із каталогу запуску для TypeORM CLI (застосунок робить це через
 * ConfigModule). Розбір — вбудованим у Node 20 `util.parseEnv`; уже задані змінні не
 * перезаписуються, тож оточення з docker-compose має пріоритет, а без файлу (як у
 * docker-образі) нічого не відбувається.
 */
export function loadDotEnvIfPresent(dir: string = process.cwd()): boolean {
  const file = join(dir, '.env');
  if (!existsSync(file)) return false;
  for (const [key, value] of Object.entries(
    parseEnv(readFileSync(file, 'utf8')),
  )) {
    if (process.env[key] === undefined && value !== undefined)
      process.env[key] = value;
  }
  return true;
}
