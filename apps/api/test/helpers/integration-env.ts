import { TEST_ADMIN_TOKEN, testApiDatabaseUrl } from './test-env';

// Виконується в кожному тестовому файлі до імпорту застосунку: ConfigModule валідує саме це оточення.
process.env.NODE_ENV = 'test';
// Застосунок — runtime-роллю API (воркер у тестах отримує свою роль, див. helpers/app.ts).
process.env.DATABASE_URL = testApiDatabaseUrl();
process.env.ADMIN_TOKEN = TEST_ADMIN_TOKEN;
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
// Кожен застосунок у тестах відкриває службовий порт метрик на випадковому вільному порту.
process.env.METRICS_PORT = '0';
// Короткі інтервали черги, щоб сценарії lease/повторів/пробудження тривали секунди, а не хвилини.
process.env.JOB_LEASE_MS = '1500';
process.env.JOB_MAX_ATTEMPTS = '3';
process.env.JOB_BACKOFF_BASE_MS = '50';
process.env.JOB_BACKOFF_MAX_MS = '500';
process.env.WORKER_POLL_INTERVAL_MS = '50';
process.env.WORKER_SHUTDOWN_GRACE_MS = '3000';
// Доставка сповіщень: короткі паузи й backoff, тож повтори й відновлення тривають секунди.
process.env.OUTBOX_POLL_INTERVAL_MS = '50';
process.env.OUTBOX_HTTP_TIMEOUT_MS = '2000';
process.env.OUTBOX_BACKOFF_BASE_MS = '100';
process.env.OUTBOX_BACKOFF_MAX_MS = '1000';
// Ліміти за IP: усі тести ходять з 127.0.0.1, тож для них — високі; тести лімітів задають свої.
process.env.ADMIN_RATE_LIMIT = '10000';
process.env.AUTH_FAILURE_RATE_LIMIT = '10000';
