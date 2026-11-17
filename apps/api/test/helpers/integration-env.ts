import { TEST_ADMIN_TOKEN, testDatabaseUrl } from './test-env';

// Виконується в кожному тестовому файлі до імпорту застосунку: ConfigModule валідує саме це оточення.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl();
process.env.ADMIN_TOKEN = TEST_ADMIN_TOKEN;
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
// Кожен застосунок у тестах відкриває службовий порт метрик на випадковому вільному порту.
process.env.METRICS_PORT = '0';
// Короткі інтервали черги, щоб сценарії lease/повторів/пробудження тривали секунди, а не хвилини.
process.env.JOB_LEASE_MS = '1500';
process.env.JOB_BACKOFF_BASE_MS = '50';
process.env.JOB_BACKOFF_MAX_MS = '500';
process.env.WORKER_POLL_INTERVAL_MS = '50';
process.env.WORKER_SHUTDOWN_GRACE_MS = '3000';
