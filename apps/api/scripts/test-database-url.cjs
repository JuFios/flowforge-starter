'use strict';
/**
 * Друкує TEST_DATABASE_URL для інтеграційних тестів і бенчмарку: власник схеми з паролем і портом
 * із кореневого .env (як у compose). Якщо .env відсутній, діють значення CI. Файл читається як
 * дані (util.parseEnv), а не виконується оболонкою.
 *
 *   export TEST_DATABASE_URL="$(node scripts/test-database-url.cjs)"
 */
const { parseEnv } = require('node:util');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const file = join(__dirname, '../../../.env');
const env = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
const password = encodeURIComponent(env.POSTGRES_PASSWORD || 'flowforge');
const port = env.POSTGRES_PORT || '5432';
process.stdout.write(
  `postgres://flowforge:${password}@localhost:${port}/flowforge_test`,
);
