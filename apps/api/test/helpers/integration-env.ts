import { TEST_ADMIN_TOKEN, testDatabaseUrl } from './test-env';

// Виконується в кожному тестовому файлі до імпорту застосунку: ConfigModule валідує саме це оточення.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl();
process.env.ADMIN_TOKEN = TEST_ADMIN_TOKEN;
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
// Кожен застосунок у тестах відкриває службовий порт метрик на випадковому вільному порту.
process.env.METRICS_PORT = '0';
