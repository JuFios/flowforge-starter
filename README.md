# FlowForge

Мультитенантна платформа автоматизації: користувач описує workflow як послідовність кроків
(`http`, `transform`, `log`, `delay`), запускає його вручну, за webhook-ом або за cron-розкладом,
а воркери виконують кроки з черги в Postgres.

Вимоги — у [`ЗАВДАННЯ.md`](ЗАВДАННЯ.md). Цей README доповнюється з кожним етапом робіт;
розділи, позначені «буде заповнено», належать до наступних етапів.

## Зміст

1. [Склад](#склад)
2. [Запуск](#запуск)
3. [Конфігурація](#конфігурація)
4. [Міграції БД](#міграції-бд)
5. [Тести](#тести)
6. [Стиль коду](#стиль-коду)
7. [Спостережуваність](#спостережуваність)
8. [Знайдені проблеми](#знайдені-проблеми)
9. [Зміни наявних тестів](#зміни-наявних-тестів)
10. [Архітектурні рішення](#архітектурні-рішення)
11. [Модель гарантій виконання](#модель-гарантій-виконання)
12. [Потік виконання і межі транзакцій](#потік-виконання-і-межі-транзакцій)
13. [Індекси і плани запитів](#індекси-і-плани-запитів)
14. [Chaos- і навантажувальні сценарії](#chaos--і-навантажувальні-сценарії)
15. [Що не встигли або зробили б інакше](#що-не-встигли-або-зробили-б-інакше)

## Склад

- `apps/api` — NestJS: HTTP API (`src/main.ts`) зі службовим портом метрик, планувальник cron
  (у процесі API), окремий процес-воркер (`src/worker.ts`) зі службовим HTTP (`/health`, `/ready`,
  `/metrics`).
- `apps/frontend` — Next.js (App Router): ввід API-ключа, список workflow, сторінка виконання.
- `docker-compose.yml` — Postgres, одноразовий крок міграцій, API, два воркери, фронтенд.
- `docker-compose.chaos.yml` і `apps/api/scripts` — оверлей і TS-скрипти chaos-сценарію
  (див. «Chaos- і навантажувальні сценарії»).

## Запуск

```bash
# один раз: випадковий адмін-токен у .env поруч із docker-compose.yml (файл у .gitignore)
printf 'ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" > .env
docker-compose up --build
```

Compose запускає API й воркери з `NODE_ENV=production` і бере `ADMIN_TOKEN` лише з `.env` у корені
(або зі змінної оточення); без нього compose завершується з підказкою, а приклад
`change-me-admin` чи очевидна заглушка зупиняють API помилкою валідації (див. «Конфігурація»).
Шаблон — `.env.example` у корені.

Порядок старту: `postgres` (healthy) → `migrate` (застосовує міграції й завершується з кодом 0)
→ `api` і два `worker` (healthy за `/ready`) → `frontend` (healthy, коли відповідає сторінка).
`docker-compose up -d --wait` повертає керування, коли всі сервіси healthy (або з помилкою). Схема БД будується лише міграціями,
тож система піднімається з порожнього тому.

| Сервіс | Адреса |
|---|---|
| API | http://localhost:3000 (`/metrics` тут немає — 404) |
| Метрики API | лише в мережі compose: `http://api:3200/metrics` |
| Фронтенд | http://localhost:3001 |
| Postgres | localhost:5432 (`flowforge` / `flowforge`) |
| Воркери | лише в мережі compose, порт `3100` (`/health`, `/ready`, `/metrics`) |

### Локальний запуск поза docker

Потрібні Node.js 20 і Docker (для Postgres). Якщо compose-стек уже запущено, звільніть порти:
`docker-compose stop api worker frontend`.

```bash
# з кореня репозиторію
docker-compose up -d postgres
cd apps/api
cp .env.example .env
sed -i.bak 's/@postgres:/@localhost:/' .env   # хост БД для запуску поза docker
npm ci
npm run build
npm run migration:run
npm run start          # API на :3000
```

Метрики API — `curl localhost:3200/metrics` (службовий порт `METRICS_PORT`).
Воркер — в іншому терміналі, з `apps/api`: `npm run start:worker` (службовий HTTP на `:3100`).
Застосунок і CLI міграцій читають `apps/api/.env` (якщо файл є); змінні, задані в оточенні
(як у docker-compose), мають пріоритет над файлом.

Фронтенд — з кореня репозиторію, в іншому терміналі:

```bash
cd apps/frontend
cp .env.example .env.local
sed -i.bak 's#http://api:3000#http://localhost:3000#' .env.local
npm ci
npm run dev -- -p 3001
```

### Приклади запитів

Створити тенанта (з кореня репозиторію; токен — `ADMIN_TOKEN` із `.env`; при локальному
запуску поза docker — з `apps/api/.env`, тобто `change-me-admin`):

```bash
ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' .env)"
curl -X POST localhost:3000/tenants -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"acme"}'
```

Відповідь містить `apiKey` (показується один раз) і `webhookSecret`. Далі всі запити — із
заголовком `x-api-key`. Необов'язковий заголовок `x-request-id` задає кореляційний ID
(інакше він генерується) і повертається у відповіді.

```bash
API_KEY=ff_...
curl -X POST localhost:3000/workflows -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"name":"demo","steps":[{"id":"hello","type":"log","message":"hi {{ input.name }}"}]}'

curl -X POST localhost:3000/workflows/<workflowId>/run -H "x-api-key: $API_KEY" \
  -H 'x-request-id: demo-1' -H 'content-type: application/json' -d '{"name":"Ada"}'

curl localhost:3000/executions/<executionId> -H "x-api-key: $API_KEY"
```

Повтор запуску без ризику дубля — заголовок `Idempotency-Key` (до 255 видимих символів ASCII):
перший запит створює виконання (201), повтор того самого запиту повертає те саме виконання (200),
той самий ключ з іншим workflow чи входом — 422.

```bash
curl -X POST localhost:3000/workflows/<workflowId>/run -H "x-api-key: $API_KEY" \
  -H 'Idempotency-Key: order-42' -H 'content-type: application/json' -d '{"name":"Ada"}'
```

Виконання, що завершилось `failed` (зокрема після вичерпаних спроб, задача `dead`), можна
повторити: воно продовжиться з першого незавершеного кроку з новим бюджетом спроб, завершені кроки
не повторюються, а повторений крок `http` надсилає той самий `Idempotency-Key`.

```bash
curl -X POST localhost:3000/executions/<executionId>/retry -H "x-api-key: $API_KEY"
```

Поки виконання стоїть на паузі (`delay`), воно має статус `running`, а час пробудження видно в
`steps[i].wakeAt` відповіді `GET /executions/:id`.

### Основні ендпоінти

| Метод | Шлях | Опис |
|---|---|---|
| POST | `/tenants` | створення тенанта (`x-admin-token`) |
| POST/GET/PATCH/DELETE | `/workflows[/:id]` | керування workflow |
| POST | `/workflows/:id/run` | запуск вручну (тіло — input; необов'язковий заголовок `Idempotency-Key`) |
| GET | `/executions`, `/executions/:id` | виконання та їхні кроки |
| POST | `/executions/:id/retry` | повтор виконання `failed` з першого незавершеного кроку (202; не `failed` — 409, чуже — 404) |
| POST | `/hooks/:workflowId` | вхідний webhook, підпис у `x-signature` (HMAC-SHA256 hex) |
| GET | `/health` | liveness: процес живий |
| GET | `/ready` | readiness: доступна БД |
| GET | `/metrics` | метрики у форматі Prometheus — **не на порту API**: службовий порт `METRICS_PORT` (API) або `WORKER_HTTP_PORT` (воркер) |

Приклад workflow з кількома кроками (результат кроку доступний наступним як
`{{ steps.<id>.<поле> }}`):

```json
{
  "name": "fetch-demo",
  "steps": [
    { "id": "fetch", "type": "http", "url": "https://example.com/?q={{ input.q }}" },
    { "id": "report", "type": "log", "message": "example.com answered {{ steps.fetch.status }}" }
  ]
}
```

**Валідація на межі API.** Тіло `POST`/`PATCH /workflows` описують DTO (`class-validator`), а
кроки перевіряє `validateSteps` (`src/workflows/definition.ts`). Невідоме поле (у тілі запиту чи в
кроці) — 400, а не мовчазне відкидання. Тіло запиту — до `HTTP_BODY_LIMIT` (100 КіБ за
замовчуванням; більше — 413). Будь-який рядок (ключ чи значення) у тілі з символом U+0000 або
одиночним сурогатом UTF-16 — 400: Postgres таких рядків не зберігає (проблема 22).

| Що | Обмеження |
|---|---|
| `name` | рядок 1..200 символів; `cron` — до 100, `timezone` — 1..64 символи; `enabled` — boolean |
| `steps` | 1..50 кроків, унікальні `id` (`^[a-z][a-z0-9_]{0,31}$`), разом до 64 КіБ JSON |
| `http` | `url` до 2048 символів, лише `http://` / `https://`; `method` — `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`; `headers` — до 50 пар рядок → рядок (ім'я — token RFC 9110 до 256 символів, значення до 8 КіБ без CR/LF); заборонені `Idempotency-Key` (його ставить платформа) і службові заголовки з'єднання (`Host`, `Content-Length`, `Transfer-Encoding`, `Connection` тощо); `body` — рядок до 32 КіБ, лише для `POST`/`PUT`/`PATCH`/`DELETE` (у `GET`/`HEAD` тіла немає; метод за замовчуванням — `GET`) |
| `transform` / `log` | `expr` / `message` — до 4096 символів |
| `delay` | `ms` — ціле 0..2 592 000 000 (30 діб): пауза — довговічний таймер, слот воркера не тримає |
| вхід виконання | тіло `POST /workflows/:id/run` і webhook-а — JSON-об'єкт до 64 КіБ; webhook перевіряє вхід лише після підпису (без підпису — 401) |

OpenAPI-документація — буде заповнено.

## Конфігурація

Конфігурація — лише через змінні оточення (`.env`). Під час старту API і воркер валідують їх
(`@nestjs/config` + `class-validator`, `src/config/env.validation.ts`) і не стартують із
невалідною конфігурацією; у повідомленні про помилку значення змінних не друкуються.

`apps/api/.env.example`:

| Змінна | За замовчуванням | Опис |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `PORT` | `3000` | порт HTTP API |
| `METRICS_PORT` | `3200` | службовий порт API лише для `GET /metrics`; compose його не публікує; `0` — випадковий вільний порт (тести) |
| `HTTP_BODY_LIMIT` | `102400` | найбільше JSON-тіло запиту, байт, 69632..1048576 (нижня межа — визначення workflow 64 КіБ плюс решта полів); більше — 413 |
| `DATABASE_URL` | — (обов'язкова) | `postgres://user:pass@host:5432/db` |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | таймаут встановлення з'єднання з Postgres, 100..60000 мс (і для CLI міграцій) |
| `DB_POOL_SIZE` | `10` | найбільше з'єднань із Postgres в одному процесі, 5..1000, не менше за `WORKER_CONCURRENCY + 4` (проблема 25); сума пулів усіх процесів має вміщатися в `max_connections` Postgres (100 за замовчуванням) |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | межа одного SQL-запиту (`statement_timeout`) і простою відкритої транзакції (`idle_in_transaction_session_timeout`), 100..600000 мс; на CLI міграцій не діє |
| `ADMIN_TOKEN` | — (обов'язкова, ≥ 12 символів) | токен `POST /tenants`; у `NODE_ENV=production` приклад і очевидні заглушки заборонені (див. нижче) |
| `LOG_LEVEL` | `info` | рівень логування pino |
| `WORKER_CONCURRENCY` | `4` | паралельні цикли обробки в одному воркері |
| `WORKER_HTTP_PORT` | `3100` | службовий HTTP воркера |
| `JOB_LEASE_MS` | `30000` | lease задачі, 500..600000 мс; воркер продовжує його кожну третину, задачу воркера, що зник, reaper повертає в чергу приблизно через цей час |
| `WORKER_POLL_INTERVAL_MS` | `500` | пауза між перевірками порожньої черги, 10..60000 мс, з відхиленням ±50% |
| `JOB_MAX_ATTEMPTS` | `5` | спроб на кожен крок, 1..100; вичерпані повторювані помилки — стан `dead` |
| `JOB_BACKOFF_BASE_MS` | `1000` | нижня межа затримки повтору, 10..3600000 мс |
| `JOB_BACKOFF_MAX_MS` | `300000` | верхня межа затримки повтору, 10..86400000 мс, не менша за `JOB_BACKOFF_BASE_MS` |
| `WORKER_SHUTDOWN_GRACE_MS` | `20000` | скільки воркер під час завершення чекає на задачі в роботі, 0..600000 мс; має бути меншим за `stop_grace_period` воркера (30 с у compose) |
| `JOB_RETENTION_DAYS` | `30` | скільки днів зберігати завершені задачі (`done`/`failed`/`dead`) у `jobs`, 1..3650; виконання й кроки не видаляються (проблема 26) |
| `EXECUTION_RETENTION_DAYS` | `0` | скільки днів зберігати історію завершених виконань (з кроками й задачами), 0..3650; `0` — зберігати завжди (за замовчуванням: історію тенанта без явного рішення оператора не видаляємо) |
| `JOB_CLEANUP_INTERVAL_MS` | `3600000` | як часто кожен воркер видаляє старі завершені задачі (і історію, якщо увімкнено), 1000..2147483647 мс, з відхиленням ±50% |
| `SCHEDULER_TICK_MS` | `30000` | період тіку планувальника, 100..2147483647 мс — **тимчасова межа** (лише ліміт таймерів Node, див. «Що не встигли») |
| `TEST_DATABASE_URL` | `postgres://flowforge:flowforge@localhost:5432/flowforge_test` | лише для інтеграційних тестів |

**Адмін-токен і `NODE_ENV`.** `apps/api/.env.example` — приклад для локальної розробки
(`NODE_ENV=development`, `ADMIN_TOKEN=change-me-admin`). У `NODE_ENV=production` валідація
відхиляє `ADMIN_TOKEN`, що містить `change-me`/`changeme`, `example`, `placeholder`, `default`,
`password`, `secret`, `qwerty`, `12345` або має менше 8 різних символів; саме значення в помилці не
друкується. docker-compose бере `apps/api/.env.example` як основу, але задає `NODE_ENV=production`
і `ADMIN_TOKEN` із кореневого `.env`. Варіанти, що розглядались: окремий `NODE_ENV` для compose
(приклад-токен працював би й далі в образі, який виглядає як production) і прибрати токен із
прикладу зовсім (локальний запуск поза docker перестав би працювати «з коробки»). Обрано
кореневий `.env`, якого немає в git: стандартний для compose механізм, секрет задає лише
користувач, а production-образ не стартує з публічно відомим значенням. Обмеження: перевірка
відсікає приклади й очевидні заглушки, але не оцінює ентропію довільного значення.

`apps/frontend/.env.example`: `API_URL` — адреса API для сервера Next.js
(`http://api:3000` у compose, `http://localhost:3000` локально).

## Міграції БД

`synchronize` вимкнено; схема змінюється лише міграціями TypeORM у
`apps/api/src/database/migrations`. Перелік міграцій явний (`migrations/index.ts`), без
glob-шаблонів, тож однаково працює в зібраному `dist` і в тестах.

```bash
cd apps/api
npm run build
npm run migration:run       # застосувати
npm run migration:revert    # відкотити останню
npm run migration:show      # стан
# нова міграція з різниці між сутностями і БД (потім додати її в migrations/index.ts):
npm run build && npm run migration:generate -- src/database/migrations/<Name>
```

Наявні міграції:

- `InitialSchema` — базова міграція схеми стартового репозиторію (як її будував `synchronize`).
  UUID генеруються вбудованою `gen_random_uuid()` (Postgres 13+), тож розширення й права на
  `CREATE EXTENSION` не потрібні.
- `AddCorrelationId` — колонка `correlationId` у `executions` і `jobs`.
- `TimestampsWithTimeZone` — `createdAt` у `tenants`, `workflows`, `executions`, `jobs` і
  `step_runs.startedAt`: `timestamp` → `timestamptz` (проблема 2). Наявні значення
  перетворюються `USING "<колонка>" AT TIME ZONE current_setting('TimeZone')`: їх записав
  `DEFAULT now()` як час у поясі сесії, а сесія успадковує пояс сервера БД. Для сервера в UTC
  (як у compose) це те саме, що `AT TIME ZONE 'UTC'`; для сервера в іншому поясі жорстко заданий
  UTC зсунув би всі рядки (це перевіряє інтеграційний тест). Припущення: пояс сервера не
  змінювався відтоді, як рядки записано. `ALTER TYPE` переписує таблиці й перебудовує індекс
  `executions (tenantId, createdAt)` під `ACCESS EXCLUSIVE` — на великих таблицях потрібне вікно
  обслуговування. `down` виконує зворотне перетворення в тому самому поясі.
- `QueueLease` — fencing-токен `jobs.lockToken`; часткові індекси `IDX_jobs_claim` і
  `IDX_jobs_lease` замість `(status, "runAt")` (проблеми 6–7).
- `StepCheckpoints` — `step_runs.attempts`, `finishedAt`, унікальний `(executionId, stepIndex)`;
  дублікати спроб стартового коду згортаються до одного рядка на крок (проблема 8).
- `WorkflowVersions` — таблиця `workflow_versions`, `executions.workflowVersionId` (FK, `CHECK`);
  версії для наявних workflow, прив'язка наявних виконань, незавершені виконання видалених
  workflow завершуються як `failed` (проблема 9).
- `DurableTimers` — `step_runs.wakeAt` (проблема 10).
- `StepIdempotencyKey` — `step_runs.idempotencyKey` (унікальний; наявні рядки отримують власний UUID).
- `JobFinishedAt` — `jobs.finishedAt` і частковий індекс `IDX_jobs_finished` для очищення
  (проблема 26); наявні завершені задачі отримують момент завершення свого виконання (або момент
  створення задачі, якщо його немає).
- `RunIdempotencyKey` — `executions.idempotencyKey` і частковий унікальний індекс
  `UQ_executions_idempotency_key` (`tenantId`, ключ) для заголовка `Idempotency-Key` запуску.
- `HistoryIndexes` — `IDX_jobs_execution` (задача виконання: повтор, очищення історії) і частковий
  `IDX_executions_finished` (очищення історії).

Команди беруть `DATABASE_URL` і `DB_CONNECT_TIMEOUT_MS` з оточення або з `apps/api/.env` (решта
конфігурації застосунку CLI не потрібна). `statement_timeout` на міграції не діє: зміна схеми
великої таблиці легітимно триває довше за запит застосунку.

Для БД, створеної стартовим кодом через `synchronize` (наприклад, том `pgdata` після запуску
стартового репозиторію в compose), базову міграцію не виконують повторно — таблиці вже є, і крок
`migrate` упав би. Її позначають як застосовану, решту міграцій застосовують тим самим образом,
що й compose, а вже потім піднімають систему. Усе — з кореня репозиторію, з `.env` з розділу
[«Запуск»](#запуск); Node.js на хості не потрібен:

```bash
docker-compose up -d postgres
docker-compose exec -T postgres psql -U flowforge -d flowforge -c \
  "CREATE TABLE IF NOT EXISTS migrations (id SERIAL PRIMARY KEY, \"timestamp\" bigint NOT NULL, name varchar NOT NULL);
   INSERT INTO migrations (\"timestamp\", name) VALUES (1794920217603, 'InitialSchema1794920217603');"
docker-compose run --rm --build migrate
docker-compose up --build
```

Те саме з хоста — після кроків [«Локальний запуск поза docker»](#локальний-запуск-поза-docker)
до `npm run build` включно (залежності встановлено, `DATABASE_URL` у `apps/api/.env` вказує на
`localhost`): ті самі `psql`-команди, потім `npm run migration:run` з `apps/api`.

Перевірено на БД, створеній стартовим кодом (і з даними в його форматі: дублікати `step_runs`,
задачі в черзі, виконання вже видаленого workflow): після цього застосовуються решта міграцій, від
`AddCorrelationId` до `HistoryIndexes`, а `migration:generate --check` не знаходить розбіжностей
між схемою і сутностями.

## Тести

```bash
cd apps/api
npm test                    # unit (без БД)
npm run test:integration    # integration на реальному Postgres (спершу збирає dist: тест падіння воркера запускає dist/worker.js)
npm run test:all            # обидва набори
```

- `test/unit` — швидкі тести без інфраструктури (`test/jest-unit.json`).
- `test/integration` — тести на реальному Postgres (`test/jest-integration.json`). Перед
  прогоном глобальний setup створює базу `flowforge_test` (якщо її немає), **видаляє схему
  `public` і будує її міграціями з нуля** — тож кожен прогін заодно перевіряє міграції.
  Запуск дозволений лише на базі з суфіксом `_test`. Файли виконуються послідовно; кожен тест
  очищає таблиці (`test/helpers/db.ts`). Локально достатньо `docker-compose up -d postgres`.
- `test/helpers` — підготовка БД, створення тенантів/workflow, запуск справжнього
  Nest-застосунку на випадковому порту (`startApp`), воркера з циклами обробки (`startWorker`) і
  зовнішнього отримувача http-кроків (`Receiver`). Інтервали черги в інтеграційних тестах короткі
  (`test/helpers/integration-env.ts`: lease 1,5 с, backoff 50..500 мс, 3 спроби), тож сценарії
  lease, повторів і пробудження тривають секунди.
- Сценарії черги: `queue-claim` (N воркерів × M задач — кожна рівно один раз), `queue-recovery`
  (lease, heartbeat, fencing), `queue-retries` (ліміт спроб, `dead`), `durable-execution`
  (чекпоінти, знімок версії, `Idempotency-Key`), `durable-timers`, `worker-shutdown`,
  `execution-atomicity`, `worker-crash` (SIGKILL процесу воркера посеред кроку), `worker-metrics`,
  `query-plans` (`EXPLAIN`), `migration-data` (перетворення наявних даних міграціями),
  `retry-after`, `connection-pool` (64 цикли, повільна БД), `job-retention`, `unstorable-text`
  (U+0000 і одиночні сурогати), `webhook-input`, `body-limit`, `run-idempotency`
  (`Idempotency-Key` запуску), `execution-retry`, `execution-retention`.
- Перевірки часу в сценаріях черги спираються на факти з БД (`wakeAt`, `runAt`, `lockToken`,
  `attempts`) за годинником БД, а не на час процесу тесту.
- Стабільність (18.11.2026, локально): увесь інтеграційний набір — 10 прогонів поспіль на
  фінальному коді, 10/10 зелені (143 тести, 59–62 с на прогін). Перша така серія виявила одне падіння
  з п'яти (`worker-metrics`, гонка воркера з підготовкою даних тесту) — виправлено, див. «Зміни
  наявних тестів», і серії відтоді повторювались з нуля після кожного набору змін.

CI (`.github/workflows/ci.yml`):

| Job | Що перевіряє |
|---|---|
| `api` | format:check, lint, typecheck, unit, build |
| `integration` | інтеграційні тести з `services: postgres` |
| `frontend` | format:check, lint, build |
| `compose` | `docker compose up --wait` з нуля: міграції, healthy API, рівно два healthy воркери і фронтенд, запуск workflow наскрізь (виконання `succeeded` зі збереженим `correlationId`); потім chaos-сценарії (`npm run chaos`: SIGKILL воркерів під навантаженням; `npm run chaos:postgres`: перезапуск Postgres під навантаженням) |

Усі job-и мають `timeout-minutes`; у `compose` очікування готовності обмежене `--wait-timeout 180`,
а кожен `curl` — `--max-time`, тож сервіс, що прийняв з'єднання й мовчить, валить job за таймаутом,
а не тримає його до 6-годинного ліміту GitHub.

## Стиль коду

- **Форматування** — Prettier 3 з налаштуваннями шаблону NestJS (`singleQuote`, `trailingComma: "all"`,
  решта — за замовчуванням), однаково в `apps/api` і `apps/frontend` (`.prettierrc`, `.prettierignore`).
- **Лінт** — ESLint 8: в API `@typescript-eslint/recommended-type-checked` (правила з урахуванням
  типів: незачекані проміси, небезпечний `any`, неявний `eval` тощо), у фронтенді
  `next/core-web-vitals`; в обох `eslint-config-prettier`, щоб правила не конфліктували з
  Prettier. Будь-яке попередження валить лінт (`--max-warnings 0`). Правило вимикається лише для
  конкретного рядка з причиною поруч (`// eslint-disable-next-line <rule> -- причина`).
- **CI** перевіряє `format:check`, `lint` і `typecheck` — порушення валить job.
- Коміт із масовим форматуванням записано в `.git-blame-ignore-revs`; локально:
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` (GitHub враховує файл сам).

```bash
cd apps/api            # або apps/frontend
npm run format         # відформатувати
npm run format:check   # перевірити без змін (як у CI)
npm run lint           # ESLint, 0 попереджень
```

## Спостережуваність

- **Логи** — структурований JSON (`nestjs-pino`). Секрети вирізаються на рівні логера
  (`src/observability/logger.options.ts`): заголовки `x-api-key`, `x-admin-token`,
  `x-signature`, `authorization`, `cookie`, `set-cookie`, а також поля `apiKey`,
  `webhookSecret`, `password`, `secret`, `token` (на верхньому й першому вкладеному рівні).
- **Кореляційний ID** — `x-request-id` із запиту (лише `[A-Za-z0-9._:-]`, до 128 символів;
  інакше генерується UUID), повертається у відповіді. Зберігається в `AsyncLocalStorage`
  (`src/observability/correlation.ts`) і потрапляє в кожен рядок логу. Зберігається в
  `executions.correlationId` і `jobs.correlationId`; воркер обробляє задачу в контексті її
  `correlationId`, тож логи кроків пов'язані з вихідним запитом. Кожне спрацювання cron
  отримує власний ID. Передача ID у вихідні запити кроків і outbox — буде заповнено.
- **Метрики** — `GET /metrics` (`prom-client`) в API і в кожному воркері: стандартні метрики
  процесу Node.js і доменні метрики в тому ж реєстрі (`MetricsService`). Воркер
  (`src/engine/queue.metrics.ts`):

  | Метрика | Тип | Що |
  |---|---|---|
  | `flowforge_job_claim_latency_seconds` | histogram | від моменту, коли задача стала готовою (`runAt`), до захоплення — обидва моменти за годинником БД |
  | `flowforge_step_duration_seconds{type,outcome}` | histogram | тривалість однієї спроби кроку (`outcome`: `succeeded` / `failed`) |
  | `flowforge_job_retries_total{reason}` | counter | спроби, після яких задачу поставлено на повтор (`step_error`, `lease_expired`) |
  | `flowforge_jobs_dead_total{reason}` | counter | задачі, що вичерпали спроби (стан `dead`) |
  | `flowforge_job_leases_expired_total` | counter | lease-и, повернуті reaper-ом (воркер зник посеред задачі) |
  | `flowforge_job_claim_failures_total` | counter | невдалі спроби захоплення (БД недоступна); лог при цьому стримує backoff |
  | `flowforge_jobs_purged_total` | counter | завершені задачі, видалені після `JOB_RETENTION_DAYS` |
  | `flowforge_executions_purged_total` | counter | виконання (з кроками й задачами), видалені після `EXECUTION_RETENTION_DAYS` |

  API: `flowforge_executions_retried_total` — виконання, поставлені на повтор через
  `POST /executions/:id/retry`.

  Мітки — лише з фіксованого набору значень (без ID тенантів і задач). Глибина черги за тенантом —
  буде заповнено (справедливе планування). Метрики віддаються лише на службових портах, які docker-compose не публікує:
  в API — окремий HTTP-сервер на `METRICS_PORT` (`src/observability/metrics-server.ts`, лише
  `GET /metrics`, решта — 404), у воркері — `WORKER_HTTP_PORT`. На публічному порту API (`PORT`)
  `/metrics` дає 404. Збирач метрик звертається з внутрішньої мережі: `api:3200`, `worker:3100`
  (кожна репліка воркера окремо).
- **Health** — `GET /health` (liveness, без залежностей) і `GET /ready` (readiness: ping БД,
  `@nestjs/terminus`) в API і воркері; використовуються healthcheck-ами docker-compose.
- **Помилки** — глобальний фільтр (`src/observability/all-exceptions.filter.ts`): `HttpException`
  віддаються як є; помилки розбору тіла запиту — зі своїм статусом 4xx і стандартним текстом
  (413 завелике тіло, 415 непідтримуване кодування чи кодова сторінка); будь-яка інша помилка —
  `{"statusCode":500,"message":"Internal server error"}`. Кожна відповідь з помилкою містить
  `correlationId` і заголовок `x-request-id`. У лог іде лише тип, повідомлення, код і стек помилки
  (без тексту SQL, параметрів запиту, деталей драйвера) разом із тим самим `correlationId`.
  У повідомленнях помилок БД (`QueryFailedError`, помилки з кодом SQLSTATE) вхідні значення, які
  Postgres повторює в тексті (`invalid input syntax for type uuid: "…"`, `value "…" is out of
  range`, `at or near "…"`, байтові послідовності), замінюються на `[redacted]` — і в `message`, і
  в першому рядку стеку; ідентифікатори (таблиця, колонка, обмеження) і SQLSTATE лишаються, а
  повідомлення довші за 300 символів обрізаються (`src/observability/safe-error.ts`). Так само
  маскується шматок вхідного рядка, який V8 повторює в помилці `JSON.parse`
  (`Unexpected token 'S', ..."ization": Sk9xQ2vLp7"... is not valid JSON`): інакше невалідне
  JSON-тіло запиту (наприклад, workflow із заголовком `Authorization`) частково потрапляло в лог.
  `/ready` при недоступній БД віддає лише `database: down`, причина — у лог.

## Знайдені проблеми

Формат кожного запису: що → чому небезпечно → як відтворити → як виправлено → альтернативи.

### 1. Тест ізоляції тенантів для виконань нічого не перевіряв

- **Що.** `apps/api/test/executions.service.spec.ts`, тест
  «does not list executions that belong to another tenant»: репозиторій замінено моком, що
  завжди повертає `[]`, а тест перевіряє, що результат дорівнює `[]`. Даних іншого тенанта в
  тесті немає, аргументи запиту до БД не перевіряються.
- **Чому небезпечно.** Назва обіцяє захист ізоляції тенантів, CI зелений, але тест лишається
  зеленим, навіть якщо фільтр за тенантом прибрати повністю. Регресія, що відкриває виконання
  всіх тенантів, пройшла б непоміченою.
- **Як відтворити.** Мутаційна перевірка: у `ExecutionsService.list` замінити
  `where: { tenantId }` на `where: {}` і запустити тест.

  ```text
  # стартовий тест, фільтр за тенантом прибрано
  ✓ does not list executions that belong to another tenant (6 ms)
  Tests:       1 passed, 1 total

  # новий інтеграційний тест, та сама мутація
  ✕ service.list returns only executions of the requested tenant (56 ms)
  ✕ GET /executions returns only executions of the caller tenant (55 ms)
  Tests:       2 failed, 2 total
  ```

- **Як виправлено.** Тест замінено на інтеграційний
  `test/integration/executions-tenant-isolation.int-spec.ts`: у реальному Postgres створюються
  два тенанти з виконаннями, перевіряється і `ExecutionsService.list`, і `GET /executions` з
  ключем тенанта A — повертаються рівно виконання A. Без мутації тест зелений, з мутацією —
  червоний.
- **Альтернативи.** Лишити unit-тест і перевіряти, що мок викликано з
  `where: { tenantId }`: дешевше, але тестує деталь реалізації (зламається при переході на
  QueryBuilder/raw SQL/RLS і не зловить помилку в самому запиті). Реальна БД перевіряє
  поведінку, а інфраструктура для неї все одно потрібна (ТЗ, розд. 6).

### 2. Моменти створення залежали від часового поясу сесії й процесу

- **Що.** `createdAt` (`@CreateDateColumn()`) у `tenants`, `workflows`, `executions`, `jobs` і
  `step_runs.startedAt` у стартовій схемі мають тип `timestamp without time zone`. `DEFAULT now()`
  записує в них «настінний» час у поясі сесії БД, а драйвер `pg` читає такі значення як локальний
  час процесу Node. Колонки `finishedAt`, `runAt`, `lockedUntil` уже були `timestamptz`.
- **Чому небезпечно.** Один і той самий момент зберігається по-різному залежно від поясу сервера
  БД чи сесії, а читається по-різному залежно від `TZ` процесу. API і воркери з різним `TZ`
  (або перенесення БД на сервер з іншим поясом) зсувають `createdAt` на години: ламаються
  сортування й курсорна пагінація виконань за `createdAt`, порівняння з `finishedAt`/`runAt`
  (тривалість, затримка захоплення), відбір за часом. Помилка мовчазна — значення виглядають
  правдоподібно.
- **Як відтворити.** `test/integration/timestamps.int-spec.ts`: два підключення із сесіями в
  `Pacific/Kiritimati` (UTC+14) і `Pacific/Pago_Pago` (UTC−11) майже одночасно створюють рядок у
  кожній таблиці; моменти мають збігатися й лежати поряд із реальним часом запису. Тест не
  залежить від поясу машини, на якій запущений. До виправлення:

  ```text
  ✕ tenants.createdAt written at the same moment from different time zones reads as the same moment
  ✕ workflows.createdAt written at the same moment from different time zones reads as the same moment
  ✕ executions.createdAt written at the same moment from different time zones reads as the same moment
  ✕ jobs.createdAt written at the same moment from different time zones reads as the same moment
  ✕ step_runs.startedAt written at the same moment from different time zones reads as the same moment
    Expected: < 0.016666666666666666   (розбіжність, години)
    Received:   24.999998055555555
  Tests:       5 failed, 5 total
  ```

- **Як виправлено.** Нова міграція `TimestampsWithTimeZone` (базову `InitialSchema` не змінено):
  `ALTER COLUMN ... TYPE timestamptz USING ... AT TIME ZONE current_setting('TimeZone')`, у
  сутностях — `@CreateDateColumn({ type: 'timestamptz' })`. Наявні рядки зберігають свій момент:
  окремий тест відкочує міграцію на базі з поясом `Pacific/Kiritimati`, записує рядок у старій
  схемі, застосовує міграцію і перевіряє, що момент не змінився (з `AT TIME ZONE 'UTC'` цей тест
  червоний: зсув на 14 годин). Тести «no drift» і revert/re-apply зелені.
- **Альтернативи.** Лишити `timestamp` і примусово працювати в UTC (`TZ=UTC` у кожному процесі та
  `-c timezone=UTC` у підключенні) — коректність тримається на конфігурації кожного процесу й
  клієнта, а схема лишається неоднозначною. Власний парсер типу `timestamp` у `pg` (читати як
  UTC) — глобальний побічний ефект, і він не виправляє запис у сесії з іншим поясом. У міграції —
  `AT TIME ZONE 'UTC'` (простіше, але неправильно для сервера не в UTC) або без `USING` (те саме
  перетворення в поясі сесії міграції, але неявно).

### 3. Запити й підключення до Postgres не мали таймаутів

- **Що.** `src/database/database.options.ts` не задавав ні таймауту з'єднання, ні
  `statement_timeout`: `pg` за замовчуванням чекає необмежено.
- **Чому небезпечно.** ТЗ (розд. 4) вимагає таймаутів на всі зовнішні виклики. Завислий запит
  (блокування, важкий план) чи сервер, що прийняв TCP і не відповідає, назавжди займає з'єднання
  пулу, HTTP-запит і слот воркера; кілька таких — і пул вичерпано, а `/ready` теж висить.
  Транзакція, покинута посередині, тримає блокування рядків черги.
- **Як відтворити.** `test/integration/db-timeouts.int-spec.ts`: застосунок із
  `DB_STATEMENT_TIMEOUT_MS=300` виконує `SELECT pg_sleep(3)`; CLI міграцій з
  `DB_CONNECT_TIMEOUT_MS=300` підключається до TCP-сервера, що мовчить. Тест сам обмежує
  очікування 5 с, тож не зависає. До виправлення:

  ```text
  ✕ cancels a query that runs longer than DB_STATEMENT_TIMEOUT_MS (3011 ms)
      Received has value: undefined        (запит виконався повністю, помилки немає)
  ✕ gives up connecting to a server that never answers after DB_CONNECT_TIMEOUT_MS (5020 ms)
      Expected: not Symbol(still pending)  (через 5 с підключення ще чекає)
  Tests:       2 failed, 2 total
  ```

- **Як виправлено.** Валідовані змінні `DB_CONNECT_TIMEOUT_MS` (5 с) і `DB_STATEMENT_TIMEOUT_MS`
  (30 с) у спільній схемі `DatabaseEnvironment`, яку валідують і застосунок, і CLI міграцій.
  `buildDataSourceOptions` задає `connectTimeoutMS`, `statement_timeout`,
  `idle_in_transaction_session_timeout` і клієнтський `query_timeout` (statement + 5 с: сервер
  скасовує запит першим із кодом `57014`, клієнт здається сам лише без відповіді взагалі).
  Для CLI міграцій діє тільки таймаут з'єднання. Тепер запит скасовується за ~0,3 с, а
  підключення — за ~0,3 с.
- **Альтернативи.** `SET statement_timeout` окремим запитом після підключення — додатковий
  round-trip і легко забути для нового пулу; параметри старту сесії задають його атомарно.
  `ALTER ROLE ... SET statement_timeout` на боці БД — не видно в коді й не діє на інші ролі.
  Лише клієнтський `query_timeout` — сервер продовжував би виконувати запит і тримати блокування.
  Окремі таймаути для захоплення задач — наступний етап (надійна черга).

### 4. Compose запускав систему з публічно відомим адмін-токеном

- **Що.** docker-compose брав `apps/api/.env.example` як є, тобто з `NODE_ENV=production` і
  `ADMIN_TOKEN=change-me-admin`, а валідація перевіряла лише довжину токена.
- **Чому небезпечно.** `POST /tenants` (створення тенанта з API-ключем) доступний кожному, хто
  прочитав README; порт API опублікований. Ніщо не змушувало змінити значення перед запуском.
- **Як відтворити.** `test/unit/admin-token.spec.ts`: `validateEnv` з `NODE_ENV=production` і
  значенням із `apps/api/.env.example` (а також `CHANGEME-please-123`, `password1234567`,
  `aaaaaaaaaaaaaaaa` тощо) має падати. До виправлення:

  ```text
  ✕ refuses the value from apps/api/.env.example
  ✕ refuses an obviously insecure value (change-me-admin)
  ✕ refuses an obviously insecure value (CHANGEME-please-123)
  …
  ✕ does not echo the refused value
  ✓ accepts a random token
  Tests:       9 failed, 1 passed, 10 total
  ```

- **Як виправлено.** Валідатор `ADMIN_TOKEN` для `NODE_ENV=production` (приклади й очевидні
  заглушки заборонені, значення не друкується). Compose задає `NODE_ENV=production` і
  `ADMIN_TOKEN` із кореневого `.env`, без якого не стартує; `apps/api/.env.example` став прикладом
  для розробки (`NODE_ENV=development`). CI генерує токен так само, як README. Перевірено, що
  compose з `ADMIN_TOKEN=change-me-admin` у `.env` не піднімає API.
- **Альтернативи.** Див. «Конфігурація» → «Адмін-токен і `NODE_ENV`»; ще варіант — генерувати
  токен при першому старті й друкувати в лог: секрет потрапив би в логи.

### 5. Планувальник і воркер писали в лог сирий текст помилок БД

- **Що.** `SchedulerService` (невдалий тік, невдале створення виконання для workflow) і цикл
  обробки `JobRunnerService` логували `error.message` рядком, в обхід `toSafeError`. Помилка
  створення виконання до того ж підписувалася як «невалідний cron». Знайдено правилами
  `recommended-type-checked` (`no-unsafe-member-access` на `e.message`).
- **Чому небезпечно.** Postgres повторює у тексті помилки вхідне значення
  (`invalid input syntax for type uuid: "…"`), а маскування значень, тип і код помилки є лише в
  `toSafeError`. Фонові цикли — саме там, де помилки БД трапляються найчастіше, і в лог ішли
  дані запиту; а хибний підпис «невалідний cron» відправляв діагностику не туди.
- **Як відтворити.** `test/unit/background-error-logging.spec.ts`: `QueryFailedError` із
  вхідним значенням у тексті на кожному з трьох шляхів. До виправлення:

  ```text
  ✕ scheduler: a failing tick
  ✕ scheduler: a failing enqueue for one workflow
  ✕ worker: a failing claim in the processing loop
  Received string: "[\"loop error: invalid input syntax for type uuid: \\\"tenant-secret-value\\\"\"]"
  Tests:       3 failed, 3 total
  ```

- **Як виправлено.** Усі три місця логують `{ error: toSafeError(err) }` із нейтральним
  повідомленням (`scheduler tick failed`, `job claim failed`) — як HTTP-фільтр помилок. Помилки,
  що стосуються конкретної задачі чи спрацювання, логуються всередині їхнього кореляційного
  контексту, тож мають той самий `correlationId`, що й решта логів цього ланцюжка:
  `job processing failed` — з `jobId` і `executionId`, `scheduled run not created` — з
  `workflowId` і `scheduledAt` (`test/unit/background-error-context.spec.ts`).
- **Альтернативи.** Редагувати секрети на рівні pino (`redact`) не допомагає: значення всередині
  рядка повідомлення, а не в окремому полі. Окремий глобальний обробник помилок для фонових задач
  — зайвий шар, коли таких місць три.

### 6. Одну задачу захоплювали кілька воркерів

- **Що.** `JobQueueService.claimNext` спершу робив `SELECT id … WHERE status = 'queued' LIMIT 1`,
  а потім окремим запитом `UPDATE … SET status = 'running'`. Між ними інші воркери бачили ту саму
  задачу як `queued` і теж її брали.
- **Чому небезпечно.** Кроки виконувались кілька разів. Для `http` це повторні платежі,
  листи, замовлення. При двох воркерах по 4 цикли кожен це не рідкість, а норма.
- **Як відтворити.** `test/integration/queue-claim.int-spec.ts`: 3 воркери (кожен зі своїм пулом
  з'єднань) розбирають 40 задач; у другому тесті виконують їх циклами обробки.

  ```text
  ✕ hands every queued job to exactly one of several concurrently polling workers
    Expected length: 40
    Received length: 193
  ✕ runs each step of each execution exactly once with several workers
    + "runs": 2,  + "runs": 3,  + "runs": 4, …
  ```

- **Як виправлено.** Вибір і захоплення — один оператор:
  `UPDATE jobs … WHERE id = (SELECT id … ORDER BY "runAt" LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`.
  `SKIP LOCKED` змушує конкурентні воркери пропускати рядок, уже заблокований іншим, тож вони не чекають і не беруть його вдруге.
- **Альтернативи.** `pg_try_advisory_lock(id)` після `SELECT`: блокування живе на сесії, при
  пулі з'єднань легко «загубити» розблокування, і все одно потрібна перевірка статусу.
  `SERIALIZABLE`-транзакція: дає помилки серіалізації під навантаженням, які треба
  повторювати. Оптимістичний `UPDATE … WHERE status = 'queued'` з перевіркою кількості рядків:
  коректний, але воркери постійно змагаються за один і той самий перший рядок.

### 7. Задачу воркера, що впав, ніхто не повертав у чергу

- **Що.** Захоплення ставило `lockedUntil`, але жоден код його не перевіряв: задача в `running`
  з простроченим lease лишалась у цьому стані назавжди, а її виконання — у `running`.
- **Чому небезпечно.** Будь-яке аварійне завершення воркера (OOM, SIGKILL, падіння вузла)
  мовчки губить виконання. Сигналу немає, повтору немає.
- **Як відтворити.** `test/integration/queue-recovery.int-spec.ts`: задача в стані, який лишає
  вбитий воркер (`running`, lease минув), і живий воркер поруч.

  ```text
  ✕ is returned to the queue after its lease expires and finished by another worker (10129 ms)
    timed out waiting for the abandoned execution to be finished by the new worker
  ```

- **Як виправлено.** Lease + heartbeat + reaper + fencing (див. рішення 3.3.1). Кожне захоплення
  видає новий `lockToken`. Воркер продовжує lease кожну третину `JOB_LEASE_MS`. Reaper у кожному
  воркері повертає прострочені задачі в чергу; прострочений lease рахується як спроба. Кожен запис
  воркера про задачу має умову на `lockToken`, тож «завислий» воркер, що прокинувся після
  повернення його задачі, нічого не перезапише (тест «does not let a worker whose lease was taken
  over record the outcome»).
- **Альтернативи.** Advisory-лок на сесію воркера замість lease: Postgres сам звільняє його, коли
  з'єднання рветься, але задача прив'язується до з'єднання; при пулі з'єднань і довгих
  кроках (з'єднання не утримується під час HTTP-виклику) це не працює. Reaper як окремий
  процес: ще одна точка відмови, тоді як у кожному воркері він дублюється безкоштовно завдяки
  `SKIP LOCKED`.

### 8. Повтор задачі заново виконував уже завершені кроки

- **Що.** Кожна спроба проходила workflow з першого кроку й створювала нові рядки `step_runs`.
  Результати завершених кроків не використовувались.
- **Чому небезпечно.** Помилка на кроці N повторює побічні ефекти кроків 1..N-1. Користувач
  платформи очікує, що «повтор» — це повтор невдалого кроку, а не всього сценарію.
- **Як відтворити.** `test/integration/durable-execution.int-spec.ts`: `charge` (успіх) →
  `notify` (перша відповідь 503).

  ```text
  ✕ resumes a retried execution from the first unfinished step without repeating completed ones
    expect(receiver.hits("/charge")).toHaveLength(1)
    Expected length: 1
    Received length: 2
  ```

- **Як виправлено.** Чекпоінти (див. рішення 3.3.2): рівно один рядок `step_runs` на крок
  (унікальний індекс `(executionId, stepIndex)`). Результат кроку фіксується транзакцією разом із
  перевіркою lease, а повтор продовжує з першого кроку без `succeeded`, беручи результати
  попередніх кроків із БД. Міграція `StepCheckpoints` згортає дублікати спроб, які
  накопичив стартовий код (лишається успішний рядок, `attempts` = кількість спроб); перевіряє
  `migration-data.int-spec.ts`.
- **Альтернативи.** Зберігати весь контекст виконання одним JSON в `executions`: менше рядків,
  але кожен чекпоінт переписує весь (зростаючий) документ, а історію спроб кроку не видно.
  Event sourcing (журнал подій виконання): гнучко, але для лінійних workflow без гілок
  (ТЗ, розд. 9) це зайва складність.

### 9. Виконання, що вже стартувало, слідувало за пізнішими змінами workflow

- **Що.** Воркер читав кроки з `workflows` у момент обробки. Зміна кроків після створення
  виконання (або між повторами) змінювала виконання, а видалення workflow ламало його:
  `findOneOrFail` падав, повторювався до вичерпання спроб, і виконання ставало `failed`.
- **Чому небезпечно.** Виконання може пройти частину кроків старої версії й частину нової, з
  невідповідними `{{ steps.* }}`. Результат не відповідає жодній версії workflow.
- **Як відтворити.** `durable-execution.int-spec.ts`: створити виконання, змінити кроки (або
  видалити workflow), потім запустити воркер.

  ```text
  ✕ runs the workflow version that was current when the execution started
    expect(receiver.hits("/v1")).toHaveLength(1)  → Received length: 0 (виконано новий крок /v2)
  ✕ finishes an execution whose workflow was deleted after it started
    Expected: "succeeded"  Received: "failed"
  ```

- **Як виправлено.** Таблиця `workflow_versions` (незмінні знімки кроків). Створення workflow і
  кожна зміна кроків записують версію в тій самій транзакції. Рядок workflow при цьому
  блокується, тож дві одночасні зміни не отримають один номер. Виконання фіксує
  `workflowVersionId` під час створення, а воркер виконує лише знімок. Зовнішнього ключа
  `workflow_versions → workflows` навмисно немає: видалення workflow не видаляє версій, на які
  посилаються виконання. `CHECK` гарантує, що знімок має кожне незавершене виконання. Міграція
  створює версії наявних workflow і завершує (`failed`, з причиною) незавершені виконання вже
  видалених workflow, які стартовий код однаково не зміг би виконати.
- **Альтернативи.** Копіювати кроки в кожне виконання (`executions.steps`): простіше, але
  дублює визначення в кожному запуску (cron щохвилини — 1440 копій на добу). М'яке видалення
  workflow: вирішує лише видалення, не зміну.

### 10. `delay` тримав слот воркера, а перезапуск починав паузу заново

- **Що.** Крок `delay` виконувався як `setTimeout` у воркері (до години).
- **Чому небезпечно.** Кілька тенантів із довгими паузами займають усі слоти, і черга стоїть.
  Перезапуск чи падіння воркера посеред паузи починав її спочатку (а до виправлення
  проблеми 7 — губив виконання).
- **Як відтворити.** `test/integration/durable-timers.int-spec.ts`: один слот на воркер, пауза
  3 с і швидке виконання; окремо — перезапуск воркера посеред паузи 2,5 с.

  ```text
  ✕ does not hold a worker slot while waiting
    timed out waiting for the quick execution to finish while the other one sleeps (1.5 s)
  ✕ wakes up at the original time after the worker is restarted
    expect(waited).toBeLessThan(3500)  Received: 6159
  ```

- **Як виправлено.** Довговічний таймер (див. рішення 3.3.3): момент пробудження фіксується в
  `step_runs.wakeAt` за годинником БД, задача повертається в чергу з `runAt = wakeAt` без lease.
  Будь-який воркер продовжує виконання, коли цей момент настане. Межу `ms` піднято до 30 діб.
- **Альтернативи.** Окремий планувальник таймерів (таблиця таймерів + процес, що будить
  задачі): ще один компонент і ще одна точка відмови. `runAt` черги вже і є таймером.

### 11. Завершення воркера лишало задачі в `running`

- **Що.** `onApplicationShutdown` лише ставив `running = false`. Nest закривав пул з'єднань, поки
  кроки ще виконувались, і вони обривались помилкою, а задача лишалась `running` з чужим lease.
- **Чому небезпечно.** Кожен деплой чи масштабування (SIGTERM) затримує або губить виконання,
  що були в роботі.
- **Як відтворити.** `test/integration/worker-shutdown.int-spec.ts`.

  ```text
  ✕ finishes the job in progress and takes no new ones while stopping
    Expected: "succeeded"  Received: "running"
  ✕ returns a job that outlives the grace period to the queue without spending an attempt
    Expected {status: queued, attempts: 0, lockedBy: null}
    Received {status: running, attempts: 1, lockedBy: "worker-57f51bc7", lockedUntil: <future>}
  ```

- **Як виправлено.** `beforeApplicationShutdown` (виконується раніше, ніж закривається пул):
  воркер перестає брати задачі, чекає на поточні до `WORKER_SHUTDOWN_GRACE_MS`, а ті, що не
  встигли, скасовує через `AbortSignal` і повертає в чергу одразу (`runAt = now()`), без
  зарахованої спроби. Продовжує інший воркер, з останнього чекпоінта. У compose
  `stop_grace_period: 30s` для воркера.
- **Альтернативи.** Лише чекати без обмеження: оркестратор однаково вб'є процес після свого
  таймауту, і задача чекатиме кінця lease. Одразу повертати все без очікування: зайві повтори
  кроків, які встигли б завершитись за секунди.

### 12. Виконання могло стати `succeeded`, поки його задача лишалась незавершеною

- **Що.** Завершення оновлювало `executions` і `jobs` окремими запитами (так само провал:
  `jobs`, потім `executions`, потім `step_runs`). Падіння між ними лишало проміжний стан
  (ТЗ, розд. 4).
- **Чому небезпечно.** Виконання `succeeded`, а задача в `running`/`queued`: її підхоплять і
  виконають усі кроки ще раз. Або виконання назавжди `running`, хоча задача вже `failed`.
- **Як відтворити.** `test/integration/execution-atomicity.int-spec.ts`: тригер БД обриває
  першу спробу позначити задачу `done` (як обрив з'єднання на цьому записі), а спостерігач
  фіксує проміжні стани.

  ```text
  ✕ never shows a succeeded execution whose job is not done, and does not repeat its steps
    expect(inconsistent).toEqual([])
    Received: ["succeeded/running", "succeeded/queued", … 285 знімків]
  ```

- **Як виправлено.** Кожна зміна стану кількох таблиць — одна транзакція, що починається з
  перевірки lease (`SELECT … FOR UPDATE` рядка задачі з умовою на `lockToken`): старт кроку,
  чекпоінт, паркування `delay`, завершення (execution + job), провал (step_run + job +
  execution), повернення задачі reaper-ом. Межі — на діаграмі в розділі «Потік виконання».
- **Альтернативи.** Ідемпотентне «доведення» стану при наступному захопленні (якщо виконання
  `succeeded` — закрити задачу): лікує наслідки одного сценарію, а не причину.

### 13. HTTP 408, 425 і 429 вважались остаточною помилкою

- **Що.** Крок `http` повторювався лише на 5xx. Таймаут запиту з боку отримувача (408),
  «Too Early» (425) і обмеження частоти (429) одразу валили виконання.
- **Чому небезпечно.** Тимчасове обмеження отримувача (найчастіше 429) перетворюється на
  остаточно провалене виконання, хоча повтор через кілька секунд пройшов би.
- **Як відтворити.** `test/unit/step-errors.spec.ts`.

  ```text
  ✕ retries a temporary failure (HTTP 408)
  ✕ retries a temporary failure (HTTP 425)
  ✕ retries a temporary failure (HTTP 429)
    Expected: true  Received: false
  ```

- **Як виправлено.** `isRetryableStatus`: 408, 425, 429 і 5xx — повторювані, решта 4xx — ні.
- **Альтернативи.** Враховувати `Retry-After`: корисно, але потребує окремої межі (тенант-отримувач
  міг би відкласти задачу на тижні). Зроблено пізніше, з межею `JOB_BACKOFF_MAX_MS` (проблема 23).

### 14. Повтори без jitter і без верхньої межі

- **Що.** `backoffMs(attempt) = 2^attempt · 1000` мс: для однакового номера спроби — однакова
  затримка, і межі немає.
- **Чому небезпечно.** Після масового збою отримувача всі задачі повторюються синхронно,
  хвилями, і знову валять його. Без межі затримка зростає необмежено, якщо ліміт спроб збільшити.
- **Як відтворити.** `test/unit/job-queue.spec.ts`.

  ```text
  ✕ spreads retries of the same attempt instead of firing them at the same moment
    Expected: not 8000
  ✕ never exceeds the cap, even after many attempts
    Expected: <= 60000  Received: 1024000
  ```

- **Як виправлено.** Затримка випадкова в межах `[base, min(max, base·2^спроба)]` («full jitter»
  з нижньою межею), `JOB_BACKOFF_BASE_MS` і `JOB_BACKOFF_MAX_MS` (валідація: max ≥ base).
- **Альтернативи.** «Equal jitter» (половина детермінована): менший розкид. «Decorrelated
  jitter»: залежить від попередньої затримки, яку довелося б зберігати. Full jitter дає
  найкращий розкид за найпростішої реалізації.

### 15. Визначення workflow і вхід виконання не валідувались на межі API

- **Що.** Тіло `POST`/`PATCH /workflows` мало тип-інтерфейс (`WorkflowInput`), тож
  `ValidationPipe` його не перевіряв. `validateSteps` перевіряв лише наявність полів, а вхід
  `POST /workflows/:id/run` міг бути будь-чим.
- **Чому небезпечно.** Без `name` — 500 (помилка БД) замість 400. Неправильні типи й довільні
  поля зберігались. Крок із нерядковим заголовком, `file://`-url чи CR/LF у заголовку проходив
  створення й валив (або спотворював) кожну спробу. Тенант міг задати власний `Idempotency-Key`
  і зламати гарантію ідемпотентності. Розмір визначення й входу був обмежений лише лімітом тіла
  запиту (ТЗ, розд. 4).
- **Як відтворити.** `test/integration/workflow-validation.int-spec.ts` і `test/unit/definition.spec.ts`.

  ```text
  integration: 10 з 11 червоні — POST без name → 500; порожній/задовгий/нерядковий name,
    enabled: "yes", cron зі 101 символу, невідоме поле → 201 (збережено); PATCH {name: 7} → 200;
    вхід-масив чи 64 КіБ → 201
  unit: 16 червоних — нерядкові заголовки, Idempotency-Key, 51 заголовок, CR/LF у значенні,
    метод TRACE, file://, url понад 2048, body понад 32 КіБ, невідоме поле, expr/message понад
    4096, дробовий ms; пауза у 7 діб відхилялась
  ```

- **Як виправлено.** DTO `CreateWorkflowDto` / `UpdateWorkflowDto`, `forbidNonWhitelisted` у
  глобальному `ValidationPipe` (невідомі поля — 400), `validateSteps` з обмеженнями з таблиці в
  «Запуск → Валідація на межі API» (повертає нормалізовані кроки: лише відомі поля, метод у
  верхньому регістрі), `RunInputPipe` для входу виконання (API і webhook), явний ліміт тіла
  запиту 100 КіБ (тепер — `HTTP_BODY_LIMIT`, проблема 17).
- **Альтернативи.** JSON Schema (ajv) або zod для кроків: окрема бібліотека й друга система
  валідації поруч із `class-validator`. Дискримінований union кроків на `class-validator`
  (`@ValidateNested` + `discriminator`) погано дає точні повідомлення для полів, що
  залежать від типу. Ручний валідатор на 200 рядків — найпрозоріший варіант.

### 16. Результат виконання розкривав текст внутрішніх помилок

- **Що.** Воркер записував `err.message` будь-якої помилки в `step_runs.error`,
  `executions.error` і `jobs.lastError`, а `GET /executions/:id` віддає перші два тенанту. Помилка
  БД чи ORM (наприклад, `EntityNotFoundError` з умовою пошуку, текст `QueryFailedError`)
  потрапляла у відповідь API. Мережеві збої кроку `http` давали неінформативне `fetch failed`.
- **Чому небезпечно.** Внутрішні деталі (імена таблиць, адреси, умови запитів) доступні тенанту
  (ТЗ, розд. 4: «помилки не розкривають внутрішні деталі»).
- **Як відтворити.** `test/integration/execution-errors.int-spec.ts`: тригер БД обриває кожен
  запис результату кроку помилкою з «внутрішнім» текстом.

  ```text
  ✕ does not expose the text of an internal error
    GET /executions/:id → "error": "internal detail: relation pg_secret at 10.0.0.7; no attempts left (3/3)"
  ✕ reports an unreachable receiver without the network details of the failure
    Received: "fetch failed; no attempts left (3/3)"
  ```

- **Як виправлено.** Тенант бачить лише помилки самого кроку (`StepError`: `http 404`,
  `transform: …`). Будь-яка інша помилка записується як `internal error while running the step`,
  а її безпечний опис (`toSafeError`) іде в лог із кореляційним ID задачі. Мережеві помилки
  `fetch` стають повторюваними `StepError` з класом збою без адрес: `http request failed:
  connection refused` / `host not found` / `connection reset` / `timed out` / `network error`.
- **Альтернативи.** Фільтрувати текст помилок регулярними виразами (як `safe-error.ts` для логів):
  у відповідь тенанту все одно потрапляв би довільний внутрішній текст, лише частково замаскований.
  Ховати й помилки кроку: тенант не зміг би зрозуміти, чому його workflow впав.

### 17. Ліміт тіла запиту не задавався конфігурацією

- **Що.** Ліміт JSON-тіла був константою `JSON_BODY_LIMIT = '100kb'` у `src/bootstrap.ts`, хоча
  погоджений план вимагав змінну конфігурації.
- **Чому небезпечно.** Межу споживання пам'яті на запит (ТЗ, розд. 4) не можна змінити без
  перезбирання образу, а зменшити її нижче легітимних тіл (визначення workflow 64 КіБ) нічого не
  заважало б.
- **Як відтворити.** `test/integration/body-limit.int-spec.ts` (застосунок із `HTTP_BODY_LIMIT=70000`)
  і `test/unit/env.validation.spec.ts`.

  ```text
  ✕ rejects a body above the configured limit with 413
    Expected: 413
    Received: 401
  ✕ bounds the HTTP body limit so the largest valid definition and run input still fit
  ```

- **Як виправлено.** `HTTP_BODY_LIMIT` (байти, за замовчуванням 102400) у схемі конфігурації,
  `.env.example` і таблиці «Конфігурація»; `configureApp` бере значення з `ConfigService`. Межі
  валідації: не менше 68 КіБ (визначення кроків 64 КіБ плюс решта полів — обидва ліміти по 64 КіБ
  уміщаються), не більше 1 МіБ.
- **Альтернативи.** Рядок у форматі `bytes` (`100kb`): зручніше читати, але розбір дає транзитивна
  залежність body-parser, на яку код не повинен спиратися, а межі валідації довелося б перевіряти
  після розбору. Ціле число байтів валідується тим самим `class-validator`.

### 18. Webhook пояснював формат входу до перевірки підпису

- **Що.** На `POST /hooks/:workflowId` `RunInputPipe` виконувався до перевірки підпису (пайп
  параметра — раніше за тіло обробника), тож запит без підпису з тілом-масивом або понад 64 КіБ
  отримував 400 з поясненням замість 401. Регресія цього PR (проблема 15).
- **Чому небезпечно.** Неавтентифікований клієнт дізнається правила валідації й ліміти, а сервер
  виконує розбір і перевірки для будь-кого, хто знає id workflow.
- **Як відтворити.** `test/integration/webhook-input.int-spec.ts`.

  ```text
  ✕ answers an unsigned delivery of an array with 401 and no details
  ✕ answers an unsigned delivery of an object above 64 KiB with 401 and no details
  ✕ answers a wrongly signed delivery of an array with 401
  ✕ answers a wrongly signed delivery of an object above 64 KiB with 401
    Expected: 401
    Received: 400
  ```

- **Як виправлено.** Перевірку входу винесено у функцію `parseRunInput`; webhook викликає її лише
  після звірки підпису, `POST /workflows/:id/run` і далі використовує `RunInputPipe` (там guard
  автентифікує раніше за пайпи).
- **Альтернативи.** Guard для webhook-а з перевіркою підпису: правильне місце, але підпис зараз
  рахується над повторно серіалізованим тілом, і його переробка на сирі байти — PR 4 (беклог);
  тоді перевірка й переїде в guard.

### 19. `GET`/`HEAD` з тілом і запити, які fetch відмовляється надсилати, повторювались як мережеві збої

- **Що.** `validateSteps` пропускав `body` для `GET`/`HEAD` (і для кроку без `method`, тобто `GET`),
  а `fetch` кидав `TypeError: Request with GET/HEAD method cannot have body`. Будь-яку помилку
  `fetch` крок вважав повторюваною мережевою (`http request failed: network error`). Так само
  повторювався запит на порт зі списку заборонених специфікацією fetch (`bad port`, напр. 9, 25).
- **Чому небезпечно.** Детермінована відмова марно витрачає всі `JOB_MAX_ATTEMPTS` спроб із
  backoff (за замовчуванням — хвилини), а виконання врешті `dead` з неправдивою причиною.
- **Як відтворити.** `test/unit/definition.spec.ts`, `test/unit/step-errors.spec.ts`.

  ```text
  ✕ rejects a body on a GET request / a body on a HEAD request / a body without a method
    Received function did not throw
  ✕ does not retry a request that fetch refuses to send (GET with a body)
  ✕ does not retry a request to a port that fetch blocks
    -   "retryable": false,
    +   "retryable": true,
  ```

- **Як виправлено.** `validateHttp` дозволяє `body` лише для `POST`/`PUT`/`PATCH`/`DELETE`.
  Повторюваними лишаються тільки справжні збої мережі (`TypeError('fetch failed')` від undici) і
  таймаут; заборонений порт — неповторювана `http request is invalid: the port is not allowed`,
  будь-яка інша помилка `fetch` — неповторювана `http request is invalid`. Тип помилки
  визначається за `name`, а не `instanceof`: undici створює помилки в іншому realm, ніж код під
  Jest. Наявний тест «unreachable receiver» звертався саме на порт 9 і перевіряв не те, що заявляв
  (див. «Зміни наявних тестів»).
- **Альтернативи.** Мовчки відкидати `body` для `GET`: тенант не дізнався б, що поле не діє.
  Перелік «відомих» не-мережевих текстів помилок: крихкий, кожна нова помилка знову стала б
  повторюваною; тут навпаки — повторюється лише те, що точно є мережею.

### 20. URL, зламаний підстановкою шаблону, повторювався як мережевий збій

- **Що.** Значення з `input`/`steps`, підставлене в `url` (напр., пробіл у хості), давало невалідний
  URL; `fetch` кидав `ERR_INVALID_URL`, а крок повторювався до `dead`. Після виправлення 19 це вже
  неповторювана, але незрозуміла `http request is invalid`.
- **Чому небезпечно.** Ті самі марні спроби, а тенант не бачить, що причина — його дані.
- **Як відтворити.** `test/unit/step-errors.spec.ts`, `test/integration/queue-retries.int-spec.ts`.

  ```text
  ✕ fails at once with an explanation when the url is invalid after substitution
  ✕ fails at once when the substituted url is longer than the url limit
  ✕ fails at once when the substitution turns the url into a non-http scheme
  ✕ fails at once when the input turns the url into an invalid one
    -   "error": "http url is invalid after template substitution",
    +   "error": "http request is invalid",
  ```

- **Як виправлено.** Перед запитом підставлений URL перевіряється (`URL.canParse`, схема лише
  `http:`/`https:`, довжина до 2048): інакше — неповторювана `http url is invalid after template
  substitution`, без звернення до мережі.
- **Альтернативи.** Кодувати підставлені значення (`encodeURIComponent`): змінило б семантику
  наявних шаблонів (тенант може свідомо підставляти шлях із `/`). Рішення щодо екранування
  шаблонів — у PR 4 (безпека шаблонізатора, беклог).

### 21. Результат кроку з U+0000 або одиночним сурогатом валив чекпоінт

- **Що.** Postgres не зберігає U+0000 ні в `jsonb` (`unsupported Unicode escape sequence`), ні в
  `text` (`invalid byte sequence for encoding "UTF8": 0x00`), а `jsonb` відкидає й одиночні
  сурогати UTF-16 (`"\ud800"`: `Unicode low surrogate must follow a high surrogate`). Відповідь
  отримувача з таким символом (JSON-екранування `\u0000`, байт `0x00` у тексті, `\ud800` у JSON)
  валила чекпоінт внутрішньою помилкою; текст помилки кроку з U+0000 (напр., з виразу `transform`)
  не записувався взагалі. Знайдено перевіркою в Postgres 16; одиночні сурогати — додатково до
  початкової знахідки.
- **Чому небезпечно.** `http`-крок, ефект якого вже стався, надсилався знову на кожній спробі, а
  виконання ставало `dead` («повтор уже виконаного кроку»). Якщо падав запис провалу, задача
  висіла до кінця lease, і виконання завершувалось оманливою причиною про зниклий воркер.
- **Як відтворити.** `test/integration/unstorable-text.int-spec.ts`.

  ```text
  ✕ checkpoints a JSON response with U+0000 in a value and a key once, with U+FFFD in place of the character
  ✕ checkpoints a JSON response with a lone surrogate once, with U+FFFD in place of the character
  ✕ checkpoints a text response with a NUL byte once, with U+FFFD in place of the character
    expect(receiver.hits('/odd')).toHaveLength(1)
    Received length: 3
  ✕ records a step error that contains U+0000
    -   "error": "transform: bad�value",
    +   "error": "lease expired: worker worker-7601ceaa stopped renewing it; no attempts left (3/3)",
  ```

- **Як виправлено.** `src/common/storable-text.ts`: `toStorable` проводить результат кроку через
  JSON (як при записі) і замінює U+0000 та одиночні сурогати в ключах і рядках на U+FFFD (символ
  заміни Unicode); `toStorableText` — те саме для текстів помилок. Чекпоінт, завершення виконання й
  запис провалу зберігають очищене значення, а наступні кроки отримують саме його (так само, як
  після відновлення з чекпоінта). Кількість замін — у лозі воркера з кореляційним ID.
- **Альтернативи (рішення погоджено).** Неповторюваний провал кроку: виконання стало б `failed`,
  хоча ефект у отримувача вже стався. Зберігати символ екранованим (`\\u0000` як текст):
  неоднозначно з легітимним рядком `\u0000` і змінює значення для шаблонів. Зберігати результат як
  `text`/`bytea`: змінює тип даних API і відновлення `ctx.steps`. Обмеження: якщо два ключі після
  заміни збіглися, лишається останній (як у `JSON.parse`).

### 22. U+0000 або одиночний сурогат у вході чи визначенні давали 500

- **Що.** Той самий символ у вході виконання (API, webhook), у кроках, `name`/`cron`/`timezone`
  workflow чи `name` тенанта проходив валідацію і падав на записі в Postgres.
- **Чому небезпечно.** 500 замість 400: помилка вхідних даних виглядає як збій сервера, а тенант не
  розуміє, що виправити (ТЗ, розд. 4: валідація на межі).
- **Як відтворити.** `test/integration/unstorable-text.int-spec.ts`, блок «at the API boundary».

  ```text
  ✕ rejects run input with U+0000 in a value / in a key / a lone surrogate (400)
  ✕ rejects signed webhook input with … (400)
  ✕ rejects a workflow with a step field with U+0000 / a lone surrogate / a name / a timezone (400)
  ✕ rejects a workflow update with U+0000 in the name (400)
  ✕ rejects a tenant name with U+0000 (400)
    Expected: 400
    Received: 500
  ```

- **Як виправлено.** `findUnstorable` (шлях до першого поганого ключа чи значення) у
  `parseRunInput` і `validateSteps`; декоратор `@IsStorableText()` на рядкових полях DTO. Відповідь —
  400 зі шляхом поля (`steps[0].message містить символ U+0000 …`).
- **Альтернативи.** Мовчки замінювати символи у вході: тенант отримав би не ті дані, які надіслав.
  Перевірка в `reviver` body-parser-а для всіх запитів: охоплює все одразу, але спрацьовує до
  перевірки підпису webhook-а (повторило б проблему 18) і дає лише загальне «Bad Request».

### 23. `Retry-After` від отримувача ігнорувався

- **Що.** На 429 і 503 повтор планувався звичайним backoff (десятки мілісекунд — секунди), навіть
  якщо отримувач просив `Retry-After: 2` чи дату.
- **Чому небезпечно.** Повтори приходять раніше, ніж отримувач готовий, отримують ту саму 429/503 і
  витрачають ліміт спроб, а виконання — `dead`, хоча за вказаний час запит пройшов би.
- **Як відтворити.** `test/integration/retry-after.int-spec.ts` (затримку фіксує тригер БД у момент
  повернення задачі в чергу) і `test/unit/step-errors.spec.ts`.

  ```text
  ✕ waits at least as long as HTTP 429 asks in seconds    Expected: >= 2000  Received: 75
  ✕ waits at least as long as HTTP 503 asks in seconds    Expected: >= 2000  Received: 66
  ✕ accepts Retry-After as an HTTP date                   Expected: >= 2900  Received: 66
  ✕ never waits longer than the backoff cap, whatever the receiver asks
                                                          Expected: >= 4500  Received: 96
  ✕ passes the Retry-After of HTTP 429/503 on to the retry
  ```

- **Як виправлено.** Для 429 і 503 `Retry-After` (ціле секунд або HTTP-date) потрапляє в
  `StepError.retryAfterMs`; затримка повтору — `min(JOB_BACKOFF_MAX_MS, max(Retry-After, backoff))`:
  не раніше, ніж просить отримувач, не коротше за звичайний backoff (нижня межа і jitter
  лишаються), не довше за верхню межу. Невалідний заголовок ігнорується.
- **Альтернативи.** Брати `Retry-After` як є: отримувач (а через нього тенант) міг би відкласти
  задачу на тижні. Ігнорувати jitter, якщо є `Retry-After`: усі задачі, що отримали однакову
  відповідь, повторились би в одну мить.

### 24. При недоступній БД кожен цикл воркера щосекунди стукав у БД і писав помилку

- **Що.** Після невдалого захоплення кожен цикл чекав 1 с і пробував знову, із записом у лог. При
  `WORKER_CONCURRENCY=64` — до 64 запитів і 64 рядків логу на секунду з одного воркера.
- **Чому небезпечно.** Лог-флуд ховає справжню причину й навантажує збирач логів, а хвиля
  підключень щойно відновленої БД заважає їй піднятися.
- **Як відтворити.** `test/unit/claim-backoff.spec.ts` (16 циклів, захоплення завжди падає).

  ```text
  ✕ probes the database with one loop at a growing interval and logs once per probe
    Expected: <= 19
    Received:    64
  ✕ resumes claiming in every loop once the database is back
  ```

- **Як виправлено.** Спільний для циклів воркера відступ: після збою — `backoffMs` (full jitter) від
  1 с до 30 с, що зростає з кожним збоєм поспіль. Поки він триває, цикли не звертаються до БД, а
  перевіряє її один цикл; лог — один рядок на перевірку (`consecutiveFailures`, `retryInMs`), після
  відновлення — `job claim recovered`. Задачі в роботі цей відступ не зачіпає (heartbeat має власну
  логіку, див. 3.3.1).
- **Альтернативи.** Окремий відступ у кожному циклі: менше запитів, але 64 незалежні таймери й ті
  самі 64 рядки логу за кожну хвилю. Зупиняти воркер до відновлення `/ready`: залежність від
  оркестратора і ризик не підхопити задачі після короткого збою.

### 25. 64 цикли на пулі з 10 з'єднань губили lease при повільній БД

- **Що.** Розмір пулу не задавався (у pg за замовчуванням — 10), а `WORKER_CONCURRENCY` дозволяв
  до 64; очікування з'єднання обмежене лише `DB_CONNECT_TIMEOUT_MS`. Heartbeat-и стояли в черзі пулу
  позаду опитувань черги всіма циклами.
- **Чому небезпечно.** Коли БД повільніша (блокування, I/O), продовження lease не встигають, reaper
  повертає задачі живого воркера, кроки повторюються (для `http` — повторний запит).
- **Як відтворити.** `test/integration/connection-pool.int-spec.ts`: 64 цикли, 64 кроки, утричі
  довші за lease. Без уповільнення пул 10 витримує (зелений і до виправлення). Коли кожне
  оновлення рядка задачі тримає з'єднання 150 мс (тригер `pg_sleep` у тесті): 11 з 64 виконань
  `failed` (перший замір) або всі `succeeded`, але з поверненими reaper-ом задачами (тест):

  ```text
  ✕ keeps every lease when each job update holds its connection for 150 ms
    + "lastError": "lease expired: worker worker-15f80686 stopped renewing it",
  ```

  Той самий сценарій із пулом 68 і 80 — зелений (≈ 6 с). При 50 мс на оновлення пул 10 ще
  витримує.
- **Як виправлено.** `DB_POOL_SIZE` (за замовчуванням 10) з валідацією `DB_POOL_SIZE ≥
  WORKER_CONCURRENCY + 4` (з'єднання на цикл плюс heartbeat-и, reaper, очищення, `/ready`);
  невідповідна конфігурація не стартує.
- **Альтернативи.** Окремий маленький пул для heartbeat-ів: менше з'єднань, але дві конфігурації
  пулу й складніша модель. Розмір пулу, обчислений із `WORKER_CONCURRENCY` автоматично: приховує від
  оператора суму з'єднань, яку треба звірити з `max_connections` Postgres.

### 26. Завершені задачі ніколи не видалялись

- **Що.** Рядок `jobs` лишався назавжди після `done`/`failed`/`dead`.
- **Чому небезпечно.** Таблиця черги росте необмежено (cron щохвилини — 1440 рядків на добу на
  workflow), разом з нею — vacuum, резервні копії й час міграцій; гарячі запити захищені
  частковими індексами, але решта — ні.
- **Як відтворити.** `test/integration/job-retention.int-spec.ts`.

  ```text
  ✕ removes done, failed and dead jobs finished long ago, in batches, and keeps the rest
    QueryFailedError: column "finishedAt" of relation "jobs" does not exist
  ```

- **Як виправлено.** Колонка `jobs.finishedAt` (міграція `JobFinishedAt` з backfill) ставиться
  разом із завершенням. Кожен воркер раз на `JOB_CLEANUP_INTERVAL_MS` (±50%) видаляє завершені
  задачі, старші за `JOB_RETENTION_DAYS` (30), пачками по 1000 окремими короткими транзакціями
  (`FOR UPDATE SKIP LOCKED`: кілька воркерів не чекають одне одного); пачка вибирається частковим
  індексом `IDX_jobs_finished`, а видаляється за первинним ключем (`id = ANY (ARRAY(...))`).
  Перша версія видаляла через `id IN (...)`, і `EXPLAIN` самого `DELETE` (а не лише вибору пачки)
  показав `Seq Scan` усієї таблиці на кожну пачку (тест `query-plans` «deleting one batch of
  finished jobs» був червоним: `hasSeqScan` → `true`); на 100 тис. задач — 8,8 мс проти 1,8 мс. `executions` і `step_runs` — історія
  тенанта, яку показує API, — не видаляються.
- **Альтернативи.** Партиціювання `jobs` за часом і `DROP PARTITION`: найдешевше видалення, але
  частковий індекс черги і `SKIP LOCKED` на партиціях складніші, а для обсягів тестового проєкту
  це передчасно. `pg_cron`: розширення й права, яких застосунок не має. Видаляти разом із
  виконаннями: втрата історії тенанта (окреме рішення про термін зберігання історії не приймалося).

### 27. Обрив або таймаут під час читання тіла відповіді показувався як внутрішня помилка

- **Що.** У кроці `http` читання тіла (`res.text()`) стояло поза обробкою помилок `fetch`. Якщо
  заголовки прийшли, а тіло — ні (обрив з'єднання, таймаут 15 с), помилка не була `StepError`, і
  тенант бачив `internal error while running the step`. Undici повідомляє про такий обрив як
  `TypeError('terminated')`, а не `fetch failed`.
- **Чому небезпечно.** Справжня причина (збій мережі отримувача) прихована; тенант і оператор
  шукають дефект платформи замість проблеми з'єднання.
- **Як відтворити.** `test/unit/step-errors.spec.ts`, `test/integration/execution-errors.int-spec.ts`
  (отримувач надсилає заголовки й частину тіла, потім рве сокет).

  ```text
  ✕ retries a step whose response body times out while being read
  ✕ retries a step whose response body loses the connection while being read
  ✕ reports a connection dropped in the middle of the response body as a network failure
    Expected: "http request failed: connection reset; no attempts left (3/3)"
    Received: "internal error while running the step; no attempts left (3/3)"
  ```

- **Як виправлено.** Читання тіла — у власному `try`: скасування воркером передається як є, решта —
  повторювана `http request failed: <клас збою>` (той самий `networkReason`).
- **Альтернативи.** Вважати будь-яку помилку тіла неповторюваною: обрив з'єднання — типовий
  тимчасовий збій, повтор зазвичай допомагає.

### 28. Завислий запит продовження lease дозволяв кроку пережити свій lease

- **Що.** `LeaseKeeper` перевіряв запас lease (20%) лише після того, як `heartbeat()` повернувся. Запит
  до БД, що завис, обмежений лише `query_timeout` (35 с) — довше за lease (30 с). За цей час reaper
  повертав задачу в чергу, інший воркер її захоплював, і той самий крок виконувався двома
  воркерами одночасно.
- **Чому небезпечно.** Fencing не дає «зомбі» записати результат, але зовнішній ефект `http`
  відбувається двічі паралельно (захищає лише отримувач, що поважає `Idempotency-Key`).
- **Як відтворити.** `test/unit/lease-keeper.spec.ts` (`heartbeat` повертає проміс, що не
  завершується).

  ```text
  ✕ gives the job up before the lease runs out even when a renewal hangs
  ✕ moves the deadline forward after every successful renewal
    Expected: true
    Received: false
  ```

- **Як виправлено.** Окремий таймер-дедлайн на `validUntil − 20% lease`, який переставляється після
  кожного успішного продовження; спрацював — крок скасовується, незалежно від того, чи
  повернувся запит.
- **Альтернативи.** Менший `query_timeout` для heartbeat: окремий пул або окреме з'єднання з іншими
  налаштуваннями, а запит, що завис на мережі, однаково чекав би TCP-таймаутів.

### 29. Reaper повертав лише 100 задач за прохід

- **Що.** `reapExpired` обробляв одну пачку (`LIMIT 100`) раз на `lease/2`.
- **Чому небезпечно.** Після масового падіння (кілька воркерів по 64 цикли) задачі поверталися б
  хвилинами, а виконання стояли б.
- **Як відтворити.** `test/integration/queue-recovery.int-spec.ts` (250 прострочених задач).

  ```text
  ✕ returns every expired job in one reaper pass, not just one batch
    Expected length: 250
    Received length: 100
  ```

- **Як виправлено.** Пачки по 100 у циклі (кожна — окрема коротка транзакція), доки пачка неповна.
- **Альтернативи.** Збільшити пачку: довша транзакція з блокуванням багатьох рядків, а межа однаково
  лишилася б.

### 30. Стиснені тіла розпаковувались до автентифікації

- **Що.** body-parser приймав `Content-Encoding: gzip`/`deflate` і розпаковував тіло до guard-а. Для
  `body-parser` 1.20.4 є advisory про падіння процесу саме на розпакуванні (GHSA-27r3-jxmh-p828,
  див. «Аудит залежностей»); відтворити падіння на Node 20.19 не вдалося, але код досяжний для
  будь-кого.
- **Чому небезпечно.** Неавтентифікований запит виконує розпакування (і можливу вразливість) на
  публічному порту; API стиснених тіл не потребує.
- **Як відтворити.** `test/integration/error-responses.int-spec.ts`.

  ```text
  ✕ refuses a gzip-compressed body with 415 before decompressing it
  ✕ refuses a deflate-compressed body with 415 before decompressing it
    Expected: 415
    Received: 401
  ```

- **Як виправлено.** `inflate: false` у налаштуваннях body-parser: стиснене тіло — 415 без
  розпакування (обхід, який рекомендує advisory).
- **Альтернативи.** `overrides` на виправлену версію body-parser: зміна дерева залежностей поза
  мажорною версією Nest, яку не змінюємо.

### 31. Повтор запиту на запуск створював друге виконання

- **Що.** Клієнт, що не отримав відповіді на `POST /workflows/:id/run` (обрив, таймаут) і повторив
  запит, отримував друге виконання; усі кроки, зокрема `http`, виконувались ще раз (зі своїми,
  новими ключами ідемпотентності).
- **Чому небезпечно.** «Повтор, щоб переконатися» подвоює ефекти. Ідемпотентність кроків не
  допомагає: це вже інше виконання.
- **Як відтворити.** `test/integration/run-idempotency.int-spec.ts`.

  ```text
  ✕ creates one execution for a repeated request with the same key
  ✕ creates one execution when the same request races itself
  ✕ rejects the same key with a different input or workflow (422)
  ✕ rejects a key that is empty / too long / containing a space (400)
  ```

- **Як виправлено.** Заголовок `Idempotency-Key` (1..255 видимих символів ASCII), колонка
  `executions.idempotencyKey` і частковий унікальний індекс (`tenantId`, ключ). Виконання з ключем
  створюється `INSERT … ON CONFLICT DO NOTHING` у тій самій транзакції, що й задача; конкурентний
  запит із тим самим ключем чекає на коміт першого й нічого не вставляє. Той самий workflow і вхід
  (порівняння `jsonb`) — 200 з наявним виконанням; інакше — 422. Без ключа — як раніше.
- **Альтернативи.** Окрема таблиця ключів із TTL: ще одна таблиця й очищення; ключ у рядку виконання
  живе рівно стільки, скільки виконання, і не потребує окремої транзакції. Хеш запиту замість
  порівняння `jsonb`: однаково потрібне збереження, а `jsonb =` уже нечутливий до порядку ключів.

### Аудит решти наявних тестів

Кожен тест перевірено мутацією коду, поведінку якого він заявляє:

| Тест | Мутація | Результат |
|---|---|---|
| `validateSteps` › accepts a valid definition | валідатор відхиляє коректний `transform` | червоний ✔ |
| `validateSteps` › rejects duplicate step ids | прибрано перевірку дублікатів | червоний ✔ |
| `validateSteps` › rejects an empty list | прибрано перевірку порожнього масиву | червоний ✔ |
| `validateSteps` › rejects an unknown step type | прибрано перевірку типу | червоний ✔ |
| `validateSteps` › rejects a negative delay | прибрано `ms >= 0` | червоний ✔ |
| `renderTemplate` › substitutes nested paths | без обходу вкладених ключів | червоний ✔ |
| `renderTemplate` › serialises objects as JSON | об'єкти через `String()` | червоний ✔ |
| `renderTemplate` › does not evaluate expressions | шаблон приймає довільний вираз | червоний ✔ |
| `renderTemplate` › renders missing values as empty string | відсутнє → `'undefined'` | червоний ✔ |
| `backoffMs` › grows exponentially | лінійний backoff | червоний ✔ |
| `ExecutionsService` › does not list executions of another tenant | прибрано фільтр тенанта | **зелений ✘** (проблема 1) |

`job-queue.spec.ts` містив два `it.todo` («claims each job exactly once…», «re-queues a job
whose worker died…»): вони нічого не перевіряли, але звіт Jest рахував їх у загальній кількості
тестів. Ця поведінка тепер перевіряється інтеграційними тестами на реальному Postgres
(`queue-claim`, `queue-recovery`; проблеми 6 і 7), а `it.todo` прибрано (див. «Зміни наявних тестів»).

Знахідки інших категорій — буде заповнено.

### Мутаційна перевірка тестів для проблем 17–26

Кожен ключовий тест перевірено, зламавши саме ту частину виправлення, яку він доводить (після
кожної мутації код відновлено):

| Мутація | Тест | Результат |
|---|---|---|
| ліміт тіла — знову константа | `body-limit` | червоний ✔ |
| webhook перевіряє вхід до підпису | `webhook-input` | червоний ✔ (4) |
| прибрано заборону тіла для `GET`/`HEAD` | `definition.spec` | червоний ✔ (3) |
| будь-яка помилка `fetch` — мережева | `step-errors.spec` | червоний ✔ |
| URL не перевіряється після підстановки | `step-errors.spec` | червоний ✔ (3) |
| очищення без одиночних сурогатів | `unstorable-text` | червоний ✔ (4) |
| чекпоінт пише результат без очищення | `unstorable-text` | червоний ✔ (3) |
| `Retry-After` без верхньої межі / ігнорується | `retry-after` | червоний ✔ (1 / 4) |
| відступ захоплення не росте / без єдиного перевіряльника | `claim-backoff.spec` | червоний ✔ ¹ |
| `DB_POOL_SIZE` не передається в пул | `connection-pool` | червоний ✔ |
| очищення видаляє й незавершені / лише одну пачку за прохід | `job-retention` | червоний ✔ ¹ |
| продовження lease не викликає heartbeat | `queue-recovery` | червоний ✔ |
| рання повторна пауза починає відлік заново | `durable-timers` | червоний ✔ ¹ |
| тіло відповіді читається поза обробкою помилок | `execution-errors` | червоний ✔ |
| без дедлайну lease / дедлайн не зсувається після продовження | `lease-keeper.spec` | червоний ✔ (2 / 3) |
| reaper — одна пачка за прохід | `queue-recovery` | червоний ✔ |
| `inflate: true` | `error-responses` | червоний ✔ (2) |
| пошук знімку з `{ id: undefined }` | `version-snapshot.spec` | червоний ✔ |
| ключ запуску не зберігається / не порівнюється запит | `run-idempotency` | червоний ✔ (3 / 1) |
| повтор без фільтра тенанта / без перевірки статусу / без блокування рядка / без нової задачі | `execution-retry` | червоний ✔ ² |
| очищення історії без кроків / лише одна пачка | `execution-retention` | червоний ✔ |
| без лічильника невдалих захоплень | `claim-backoff.spec` | червоний ✔ |

¹ Перший прогін мутацій ці тести пропустили (зелені): заглушка захоплення падала миттєво;
«незавершену» задачу воркер у тесті просто виконував; пачки доробляли наступні проходи; тест ранньої
повторної паузи не перевіряв, що `wakeAt` не змінився. Тести посилено (окремий коміт), після чого
всі мутації червоні.

² «Без блокування рядка» перший раз вижила: два «одночасні» повтори насправді не перетиналися в часі.
Тест отримав тригер, що затримує зміну виконання на 300 мс, тож друга транзакція читає рядок раніше,
ніж перша закомітить, — після цього мутація червона.

## Зміни наявних тестів

| Файл | Зміна | Обґрунтування |
|---|---|---|
| `test/definition.spec.ts`, `test/template.spec.ts`, `test/job-queue.spec.ts` | перенесено в `test/unit/`, змінено лише відносні шляхи імпорту | розділення unit / integration на окремі конфігурації Jest; зміст тестів не змінено |
| `test/executions.service.spec.ts` | видалено, замінено на `test/integration/executions-tenant-isolation.int-spec.ts` | тест проходив незалежно від наявності фільтра за тенантом (проблема 1) |
| конфігурація Jest у `package.json` | винесено в `test/jest-unit.json` і `test/jest-integration.json` | старий `testRegex` збирав як тести будь-які файли в `test/`, зокрема хелпери |
| `test/unit/definition.spec.ts`, `test/unit/template.spec.ts`, `test/unit/job-queue.spec.ts` | автоформатування Prettier (лапки, перенесення рядків) | єдиний стиль коду; логіка й перевірки не змінені (коміт у `.git-blame-ignore-revs`) |
| `test/unit/job-queue.spec.ts` › «grows exponentially with the attempt number» | замінено тестами діапазону, розкиду (jitter), зростання межі й верхньої межі; `backoffMs` отримує налаштування й джерело випадковості | детерміновану формулу `2^n` замінено на jitter із межею (проблема 14), точні значення `2000/4000/8000` більше не є заявленою поведінкою; зростання межі з номером спроби перевіряється й далі |
| `test/unit/job-queue.spec.ts` › два `it.todo` | прибрано | ця поведінка тепер доведена інтеграційними тестами на реальному Postgres (`queue-claim`, `queue-recovery`), unit-тест її перевірити не може |
| `test/unit/background-error-*.spec.ts` | конструктор `JobRunnerService` отримує нові залежності (`CheckpointService`, репозиторій `WorkflowVersion`, `QueueMetrics`); мок черги має `reapExpired`; зупинка — `beforeApplicationShutdown` | змінилися лише залежності, які тест підставляє заглушками; перевірки (лог помилки з кореляційним ID, без секретів) ті самі |
| `test/integration/worker-correlation.int-spec.ts` | задача для `process()` береться через `claimNext`, виконання створюється хелпером зі знімком версії | обробляти можна лише захоплену задачу (з lease і fencing-токеном), а виконання без знімку версії заборонене `CHECK`; перевірка кореляції та сама |
| `test/integration/timestamps.int-spec.ts` | рядок `executions` вставляється зі статусом `succeeded` | `CHK_executions_version_snapshot` вимагає знімок версії лише від незавершених виконань; тест перевіряє `createdAt`, статус на нього не впливає |
| `test/helpers/db.ts` | `createWorkflow` створює й першу версію; `truncateAll` очищає лише наявні таблиці | хелпери відтворюють те, що робить застосунок; тести міграцій тимчасово відкочують схему, і новіших таблиць у цей момент ще немає |
| `test/integration/execution-errors.int-spec.ts` › «reports an unreachable receiver…» | порт 9 замінено на щойно звільнений порт; перевіряється `http request failed: connection refused` | порт 9 входить до списку заборонених fetch (`bad port`): тест перевіряв не відмову з'єднання, а блокування порту, яке тепер — окрема неповторювана помилка (проблема 19) |
| `test/unit/background-error-logging.spec.ts` › worker, `test/unit/claim-backoff.spec.ts` | у заглушку конфігурації додано `JOB_CLEANUP_INTERVAL_MS`, у заглушку метрик — лічильник `claimFailures` | воркер планує очищення старих задач (проблема 26); без значення таймер спрацьовував одразу й додавав рядки логу, які тест не перевіряє; перевірка лише одного рядка про збій захоплення та сама |
| `test/integration/query-plans.int-spec.ts` | засіяні завершені задачі мають `finishedAt`; засіяно й 20 тис. виконань; додано випадки для запитів очищення, ключа запуску й задачі виконання | реалістичний розподіл для нових запитів; наявні перевірки планів ті самі |
| `test/integration/queue-retries.int-spec.ts` | `start()` приймає вхід виконання; додано перевірки `finishedAt` | новий тест URL після підстановки (проблема 20) потребує входу; наявні перевірки ті самі |
| `test/integration/queue-recovery.int-spec.ts` › «keeps its lease…» | додано спостереження за рядком задачі під час кроку: один `lockToken`, кілька значень `lockedUntil` | тест заявляв продовження lease, але перевіряв лише наслідок (одна спроба); тепер видно й сам heartbeat у БД |
| `test/integration/durable-timers.int-spec.ts` | замість очікування з межею 1,5 с і `waited < 3500` — факти з БД: швидке виконання завершилось раніше за `wakeAt`; `wakeAt` не змінився після перезапуску, `wakeAt − startedAt ≈ ms`, крок завершився не раніше за `wakeAt` | межі часу залежали від швидкості машини (повільний CI давав хибне падіння); нові перевірки доводять ту саму поведінку одним годинником (БД) |
| `test/integration/worker-shutdown.int-spec.ts` | `runAt <= now()` перевіряється в SQL, а не порівнянням із `Date.now()` процесу | годинник процесу тесту й БД можуть розходитись; межа тривалості завершення (grace) лишилась — це сама заявлена поведінка |
| `test/integration/worker-metrics.int-spec.ts` | воркер стартує після підготовки задачі «зниклого воркера», а не в `beforeAll`; перед читанням метрик — очікування останніх подій у самих метриках | серія з 10 прогонів показала падіння (1 з 5): воркер устигав захопити задачу раніше, ніж тест переводив її в стан із простроченим lease, і лічильники залежали від того, хто встиг першим. Лічильник оновлюється одразу після транзакції, тож і читання одразу після неї зрідка не встигало. Очікувані значення ті самі |

## Архітектурні рішення

### Фундамент

**Схема БД: міграції замість `synchronize`.**
Варіанти: `synchronize: true` (як у стартовому коді); `migrationsRun` при старті кожного
процесу; окремий крок міграцій перед стартом. Обрано окремий крок (`migrate` у compose, CLI
TypeORM): `synchronize` може мовчки видалити колонку з даними при зміні сутності, а кілька
інстансів, що стартують одночасно, змагаються за зміну схеми; `migrationsRun` у кожному
процесі має ту саму гонку. Відповідність міграцій сутностям перевіряє інтеграційний тест
(«no drift»), відкат — тест revert/re-apply. Обмеження: нову міграцію треба вручну додати в
`migrations/index.ts`. Міграції, що перетворюють наявні дані (`StepCheckpoints`, `WorkflowVersions`),
перевіряє `migration-data.int-spec.ts`: БД відкочується до стану перед міграцією, заповнюється даними
в старому форматі, міграція застосовується знову. Міграції виконуються до старту воркерів; оновлення
«на ходу», коли старі воркери ще працюють зі старою схемою, не підтримується.

**Конфігурація.** `@nestjs/config` з валідацією через наявний `class-validator` (підхід із
документації Nest), без окремої бібліотеки схем. Одна схема для API і воркера — вони
запускаються з одного образу й одного `.env`.

**Інтеграційні тести на реальному Postgres.** Варіанти: Testcontainers, pg-mem, реальний
Postgres із compose/CI. Обрано реальний Postgres (`services: postgres` у CI, контейнер із
compose локально): семантика черги (`SKIP LOCKED`, блокування, RLS) має сенс лише на
справжньому Postgres, pg-mem її не підтримує, а Testcontainers додає залежність від Docker
у тестовому процесі без виграшу для CI.

**Кореляція й логування.** `nestjs-pino` (pino-http) + власний `AsyncLocalStorage` (вбудований
у Node): один механізм для HTTP-запитів, задач воркера й cron. Альтернатива — `nestjs-cls`:
зайва залежність для однієї властивості контексту. Воркер отримав службовий HTTP-порт, щоб
мати ті самі `/health`, `/ready`, `/metrics`, що й API.

**Метрики не на публічному порту.** Порт API опублікований назовні, а метрики розкривають
внутрішній стан (а з доменними метриками — і тенантів). Варіанти: токен для збирача на тому самому
порту; прив'язка до `127.0.0.1`; окремий службовий порт. Обрано службовий порт `METRICS_PORT`
(як `WORKER_HTTP_PORT` у воркера): compose його не публікує, секрет для збирача не потрібен, а
публічний порт метрик не віддає взагалі (404). Токен лишив би `/metrics` досяжним ззовні й додав
секрет для ротації; `127.0.0.1` недосяжний для збирача з іншого контейнера. Реалізація — вбудований
`node:http` у процесі API зі спільним реєстром `MetricsService`, без другого Nest-застосунку.
`/health` і `/ready` лишаються на `PORT`: від них залежать healthcheck-и compose, і вони віддають
лише `up`/`down`. Обмеження: службовий порт захищає мережева межа, а не автентифікація — у
середовищі, де внутрішня мережа не довірена, знадобиться ще й автентифікація збирача.

### 3.3.1 Надійна черга

**Механізм черги (ТЗ, розд. 2).** Варіанти: `FOR UPDATE SKIP LOCKED`, lease у рядку задачі,
advisory-локи Postgres. Обрано `SKIP LOCKED` для захоплення + lease (`lockedUntil`) з
fencing-токеном (`lockToken`) для володіння задачею. Advisory-локи прив'язані до сесії
з'єднання: вони звільняються, лише коли рветься саме це з'єднання, а воркер не тримає з'єднання
під час HTTP-кроку (до 15 с) і бере їх із пулу на кожну транзакцію. Довелося б або тримати
окреме з'єднання на кожну задачу (ліміт з'єднань Postgres ділиться на всі воркери), або
лишитися без автоматичного звільнення. Lease у рядку видно в БД (хто тримає, до коли), він
переживає перепідключення, а повернення задачі — звичайний `UPDATE`.

- **Захоплення** — один `UPDATE … WHERE id = (SELECT … ORDER BY "runAt" LIMIT 1 FOR UPDATE SKIP
  LOCKED) RETURNING *` (проблема 6). Кожне захоплення видає новий `lockToken`.
- **Lease і heartbeat.** `JOB_LEASE_MS` (30 с); `LeaseKeeper` продовжує lease кожну третину.
  Якщо продовження змінило 0 рядків, lease забрали: `AbortSignal` скасовує поточний крок, і
  воркер більше нічого не пише. Тимчасова помилка БД не скасовує роботу одразу: спроби тривають,
  поки за годинником воркера лишається понад 20% lease.
- **Повернення задач** — reaper у кожному воркері (раз на `lease/2`, `SKIP LOCKED`, пачками по
  100). Прострочений lease рахується як спроба і повертає задачу з тим самим backoff: «отруйна»
  задача, що раз у раз валить воркер, закінчиться в `dead`, а не крутитиметься вічно.
- **Fencing.** Кожен запис про задачу (чекпоінт, завершення, провал, повернення) — транзакція, що
  починається з `SELECT … FOR UPDATE` рядка задачі з умовою `lockToken = $мій`. Воркер, якого
  вважали мертвим, але який прокинувся, нічого не перезапише.
- **Повтори.** Помилки повторювані: мережа і таймаут, HTTP 408/425/429/5xx, будь-яка не
  класифікована помилка (наприклад, збій БД). Неповторювані: решта 4xx, помилки `transform`. Затримка — full
  jitter у межах `[JOB_BACKOFF_BASE_MS, min(JOB_BACKOFF_MAX_MS, base·2^спроба)]`.
- **Ліміт спроб і `dead`.** `JOB_MAX_ATTEMPTS` (5) на кожен крок: лічильник починається знову
  після кожного чекпоінта, тож довгий workflow не «з'їдає» ліміт. Стани задачі: `queued`,
  `running`, `done`, `failed` (неповторювана помилка), `dead` (повторювані помилки вичерпали
  ліміт або lease минув на останній спробі). Виконання в обох останніх випадках — `failed` з
  причиною.
- **Graceful shutdown** (проблема 11): `beforeApplicationShutdown` → не брати нових → чекати до
  `WORKER_SHUTDOWN_GRACE_MS` → скасувати й повернути решту без зарахованої спроби.
- **Час** — завжди годинник БД (`now()`): `runAt`, `lockedUntil`, `wakeAt`, backoff. Розбіжність
  годинників воркерів на чергу не впливає.
- **`Retry-After`** (проблема 23): для 429 і 503 затримка повтору — не менша за запитану
  отримувачем, але в межах `[backoff, JOB_BACKOFF_MAX_MS]`.
- **Неповторювані помилки запиту** (проблеми 19–20): невалідний після підстановки URL,
  заборонений порт, запит, який `fetch` відмовляється надсилати — одразу `failed`.
- **Збій БД під час захоплення** (проблема 24): спільний для циклів воркера експоненційний відступ
  1..30 с, один цикл перевіряє відновлення, один рядок логу на перевірку.
- **Пул з'єднань** (проблема 25): `DB_POOL_SIZE ≥ WORKER_CONCURRENCY + 4`, перевіряється під час
  старту.
- **Дедлайн lease** (проблема 28): окремий таймер скасовує крок, коли до кінця відомого lease
  лишилось 20%, навіть якщо запит продовження ще не повернувся. Reaper повертає всі прострочені
  задачі за прохід, пачками по 100 (проблема 29).
- **Повтор виконання** (`POST /executions/:id/retry`). Варіанти: лише стан `dead` для розбору в БД
  (вимога ТЗ уже виконана); новий запуск того самого workflow (втрачає результати завершених кроків
  і повторює їхні ефекти); продовження того самого виконання. Обрано останнє: одна транзакція з
  блокуванням рядка виконання — задача знову `queued` з новим бюджетом спроб (або нова, якщо стару
  вже видалило очищення), виконання — `running`/`pending`. Завершені кроки не повторюються, повторений
  `http` має той самий `Idempotency-Key`. Лише своє виконання тенанта (запит уже з `tenantId`, не
  чекаючи PR 3) і лише `failed`. Обмеження: повтор не застосовує нову версію workflow — виконання
  лишається на своєму знімку.
- **Очищення історії виконань** (`EXECUTION_RETENTION_DAYS`, за замовчуванням вимкнене). Варіанти:
  зберігати завжди; видаляти разом із задачами за тим самим терміном; окремий термін. Обрано окремий
  налаштовуваний термін, вимкнений за замовчуванням: історію тенанта, яку показує API, без рішення
  оператора не видаляємо. Увімкнене — те саме очищення воркера пачками по 500: кроки, задачі й
  виконання одним оператором (`PURGE_EXECUTIONS_SQL`), лише завершені виконання. Разом із виконанням
  зникає і його `Idempotency-Key`.
- **Очищення завершених задач** (проблема 26). Варіанти: видаляти разом із виконаннями (втрата
  історії тенанта), партиціювання за часом, `pg_cron`, періодичне видалення пачками у воркерах.
  Обрано останнє: `jobs.finishedAt`, частковий індекс, пачки по 1000 з `SKIP LOCKED`,
  `JOB_RETENTION_DAYS` (30). Обмеження: видалення пачками — це dead tuples для autovacuum; на дуже
  великих обсягах краще партиціювання. Історія виконань (`executions`, `step_runs`) не
  обмежена — термін її зберігання — окреме рішення.

Обмеження: опитування (`WORKER_POLL_INTERVAL_MS` з jitter) замість `LISTEN/NOTIFY` дає
затримку захоплення до інтервалу опитування в порожній черзі (видно в
`flowforge_job_claim_latency_seconds`). Повернення задачі зниклого воркера займає від `lease` до
`1,5·lease`. Справедливість між тенантами в запиті захоплення — розділ 3.3.5 (буде заповнено).

### 3.3.2 Durable execution

Варіанти: перезапуск workflow з нуля (стартовий код), чекпоінт кожного кроку в окремому рядку,
весь контекст одним документом, журнал подій. Обрано рядок на крок (`step_runs`, унікальний
`(executionId, stepIndex)`): результат кроку записується разом із перевіркою lease, повтор
продовжує з першого кроку без `succeeded`, а `ctx.steps` відновлюється з `output` завершених кроків.
Видно історію кожного кроку (`attempts`, `error`, `startedAt`/`finishedAt`).

- **Ключ ідемпотентності.** `step_runs.idempotencyKey` (UUID) створюється разом із рядком кроку
  при першій спробі й не змінюється. Усі спроби цього кроку, також після падіння воркера,
  надсилають той самий заголовок `Idempotency-Key`. Тенант власного `Idempotency-Key` задати не
  може. Ключ не залежить від номера спроби: інакше отримувач не відрізнив би повтор від нового
  запиту. Унікальний індекс дає пошук кроку за ключем.
- **Знімок версії.** `workflow_versions` + `executions.workflowVersionId` (проблема 9):
  виконання працює з кроками, зафіксованими під час створення; правки й видалення workflow його
  не зачіпають. Виконання без знімку воркер не запускає (неповторюваний провал): пошук
  `{ id: undefined }` TypeORM виконав би без умови й повернув першу-ліпшу версію. `CHECK` у БД такого
  стану не допускає — це остання лінія захисту (`test/unit/version-snapshot.spec.ts`).
- **Ключ запуску.** `Idempotency-Key` на `POST /workflows/:id/run` (проблема 31) — рівно одне
  виконання на ключ у тенанті.

Обмеження: `transform` і `log` не мають зовнішнього ефекту, тож ключа не отримують. Якщо воркер
упаде посеред такого кроку, крок обчислиться ще раз (результат той самий, `log` може
повторитись у логах). Ефективно-одноразовий ефект `http` гарантується лише для отримувача,
що враховує `Idempotency-Key`; без цього — щонайменше один раз (див. «Модель гарантій»).

### 3.3.3 Довговічні таймери

Варіанти: `setTimeout` у воркері (стартовий код), окрема таблиця таймерів із власним процесом,
сама черга як таймер. Обрано чергу: крок `delay` в одній транзакції записує
`step_runs.wakeAt = now() + ms` і повертає задачу в `queued` з `runAt = wakeAt`, звільняючи lease
і не зараховуючи спробу. Задачу візьме будь-який воркер, коли настане `runAt`. Якщо її взяли
раніше (повернули вручну чи reaper-ом), вона паркується знову до того самого `wakeAt`, а не
відраховує паузу заново. Слот воркера під час паузи вільний, перезапуск будь-якого компонента
таймер не скидає.

Обмеження: точність пробудження — інтервал опитування черги (за замовчуванням до 0,75 с) плюс
черга перед задачею. Під час паузи виконання має статус `running` (окремого `waiting` немає).
Межа паузи — 30 діб.

### 3.3.4 Ізоляція тенантів у глибину — буде заповнено

### 3.3.5 Справедливе планування — буде заповнено

### 3.3.6 Безпечне виконання кроків — буде заповнено

### 3.3.7 Вхідні webhook-и — буде заповнено

### 3.3.8 Планувальник — буде заповнено

## Модель гарантій виконання

| Рівень | Гарантія | Умови |
|---|---|---|
| Захоплення задачі | у кожен момент задачу тримає не більше одного воркера, і лише він може записати її результат | `SKIP LOCKED` + fencing-токен; «завислий» воркер після втрати lease нічого не запише |
| Крок `http` | **щонайменше один раз**; **effectively-once** для отримувача, що враховує `Idempotency-Key` | повтор можливий, якщо воркер упав або втратив lease після надсилання запиту, але до чекпоінта; усі спроби кроку мають один ключ |
| Крок `transform` / `log` | щонайменше один раз (результат детермінований, побічного ефекту назовні немає) | повтор — лише якщо падіння сталося посеред кроку |
| Крок `delay` | пауза не коротша за `ms` і не починається заново після перезапуску | `wakeAt` у БД |
| Завершений крок | **не виконується повторно** | чекпоінт записано (транзакція з перевіркою lease) |
| Запуск через API | з `Idempotency-Key` — рівно одне виконання на ключ у тенанті (повтор того самого запиту повертає те саме виконання); без ключа — кожен запит створює нове, тож повтор клієнтом після обриву — щонайменше один раз | ключ зберігається, поки зберігається виконання (`EXECUTION_RETENTION_DAYS`) |
| Повтор виконання (`/retry`) | продовжує з першого незавершеного кроку; завершені кроки не повторюються, повторений `http` має той самий `Idempotency-Key` | лише виконання `failed` свого тенанта; два одночасні повтори — проходить один |
| Виконання | завершується (`succeeded` / `failed`) рівно один раз; кроки — за знімком версії на момент створення | поки є живий воркер; кожен крок має `JOB_MAX_ATTEMPTS` спроб, потім задача `dead`, а виконання `failed` |
| Вихідна подія | буде заповнено (outbox) | — |

Що **не** гарантується: exactly-once для отримувача, який ігнорує `Idempotency-Key` (це
неможливо без його участі: відповідь могла загубитися вже після виконання запиту). Порядок
виконань між собою: різні виконання незалежні. Побайтова точність результату кроку: U+0000 і
одиночні сурогати, яких Postgres не зберігає, у збереженому результаті замінено на U+FFFD
(проблема 21).

## Потік виконання і межі транзакцій

Кожен прямокутник — одна транзакція. Крок (зовнішній виклик) виконується поза транзакцією, тож
з'єднання з БД не утримується під час HTTP-запиту. Всі транзакції воркера починаються з
перевірки lease.

```mermaid
flowchart TD
  T["Тригер: POST /run, webhook, cron"] --> E["TX: execution (workflowVersionId) + job queued"]
  E --> C["Захоплення: UPDATE … FOR UPDATE SKIP LOCKED → running, lockToken"]
  C --> L{"Наступний крок без succeeded?"}
  L -- "так, http / transform / log" --> S["TX: lease ✓, step_run running (attempts+1), execution running"]
  S --> X["Виконання кроку поза транзакцією (Idempotency-Key, AbortSignal)"]
  X -- успіх --> K["TX: lease ✓, step_run succeeded + output, job.attempts = 1"]
  K --> L
  X -- помилка --> F["TX: lease ✓, step_run failed, job queued з backoff / failed / dead, execution failed (якщо кінець)"]
  F -- retry --> C
  L -- "так, delay" --> P["TX: lease ✓, step_run.wakeAt, job queued, runAt = wakeAt"]
  P -- "runAt настав" --> C
  L -- "ні, кроків більше немає" --> D["TX: lease ✓, job done + execution succeeded"]
  H["Heartbeat кожну lease/3: UPDATE lockedUntil WHERE lockToken"] -.-> C
  R["Reaper: TX прострочені lease → queued з backoff або dead + execution failed"] -.-> C
```

## Індекси і плани запитів

| Запит | Індекс |
|---|---|
| захоплення наступної задачі | `IDX_jobs_claim` — `jobs ("runAt") WHERE status = 'queued'` (частковий) |
| пошук прострочених lease (reaper) | `IDX_jobs_lease` — `jobs ("lockedUntil") WHERE status = 'running'` (частковий) |
| запуск за `Idempotency-Key` тенанта | `UQ_executions_idempotency_key` — унікальний `executions ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL` (частковий) |
| задача виконання (повтор, очищення історії) | `IDX_jobs_execution` — `jobs ("executionId")` |
| завершені виконання, старші за термін історії | `IDX_executions_finished` — `executions ("finishedAt") WHERE status IN ('succeeded', 'failed')` (частковий) |
| завершені задачі, старші за термін зберігання (очищення) | `IDX_jobs_finished` — `jobs ("finishedAt") WHERE status IN ('done', 'failed', 'dead')` (частковий) |
| пошук кроку за ключем ідемпотентності | `UQ_step_runs_idempotency_key` — унікальний `step_runs ("idempotencyKey")` |
| чекпоінти виконання | `UQ_step_runs_execution_step` — унікальний `step_runs ("executionId", "stepIndex")` |
| версія workflow для виконання | `UQ_workflow_versions_workflow_version` — унікальний `("workflowId", "version")` |
| списки виконань за тенантом | `executions ("tenantId", "createdAt")` (зі стартового коду; перевірка плану — буде заповнено) |

Часткові індекси містять лише задачі в черзі чи в роботі, а завершені (яких з часом переважна
більшість) не потрапляють в індекс. На 100 тис. задач (99,8% `done`) кожен із них займає 16 КіБ.
Старий індекс `(status, "runAt")` видалено.

**Як перевірено.** Інтеграційний тест `query-plans.int-spec.ts` засіває 20 тис. задач і кроків
і для того самого SQL, що виконує черга (`CLAIM_CANDIDATE_SQL`, `EXPIRED_LEASES_SQL`,
`FINISHED_JOBS_SQL`, `PURGE_FINISHED_SQL`, `PURGE_EXECUTIONS_SQL`, пошук за ключем запуску й
задачі за виконанням), перевіряє в
`EXPLAIN (FORMAT JSON)`, що використовується потрібний індекс і немає `Seq Scan`. Вручну на
100 тис. задач (`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)`):

```text
-- захоплення
Limit (actual rows=1 loops=1)
  ->  LockRows (actual rows=1 loops=1)
        ->  Index Scan using "IDX_jobs_claim" on jobs (actual rows=1 loops=1)
              Index Cond: ("runAt" <= now())
-- reaper
Limit (actual rows=100 loops=1)
  ->  LockRows (actual rows=100 loops=1)
        ->  Index Scan using "IDX_jobs_lease" on jobs (actual rows=100 loops=1)
              Index Cond: ("lockedUntil" < now())
-- ключ ідемпотентності
Index Scan using "UQ_step_runs_idempotency_key" on step_runs (actual rows=0 loops=1)
  Index Cond: ("idempotencyKey" = '…'::uuid)
-- очищення: одна пачка (PURGE_FINISHED_SQL, 100 тис. задач, 99,6% done, термін 30 днів)
Delete on jobs (actual rows=0 loops=1)
  InitPlan 1 (returns $1)
    ->  Limit (actual rows=1000 loops=1)
          ->  LockRows (actual rows=1000 loops=1)
                ->  Index Scan using "IDX_jobs_finished" on jobs jobs_1 (actual rows=1000 loops=1)
                      Index Cond: ("finishedAt" < (now() - '30 days'::interval))
  ->  Bitmap Heap Scan on jobs (actual rows=1000 loops=1)
        Recheck Cond: (id = ANY ($1))
        ->  Bitmap Index Scan on "PK_cf0a6c42b72fcc7f7c237def345" (actual rows=1000 loops=1)
Execution Time: 1.784 ms
-- очищення історії: одна пачка (PURGE_EXECUTIONS_SQL, 20 тис. виконань із кроком і задачею)
Delete on executions e
  CTE batch -> … ->  Bitmap Index Scan on "IDX_executions_finished"
  CTE steps -> Delete on step_runs s -> … Bitmap Index Scan on "UQ_step_runs_execution_step" (actual rows=316)
  CTE queue -> Delete on jobs j -> … Bitmap Index Scan on "IDX_jobs_execution" (actual rows=316)
  ->  Bitmap Index Scan on "PK_703e64e0ef651986191844b7b8b"
Execution Time: 3.647 ms
```

Перша версія видалення кроків і задач (`= ANY ((SELECT ids FROM batch))`) навіть не виконувалась
(`uuid = uuid[]`), а варіант без індексу `IDX_jobs_execution` читав `jobs` повністю (`Seq Scan`) на
кожну пачку — звідси індекс і форма `USING batch`.

## Chaos- і навантажувальні сценарії

### Вбивство воркерів під навантаженням (3.3.1–3.3.3)

```bash
# з кореня репозиторію; .env з ADMIN_TOKEN — як у «Запуск»
(cd apps/api && npm ci && npm run chaos:sink:build)
docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --build --wait
(cd apps/api && npm run chaos)
```

Оверлей `docker-compose.chaos.yml` додає `sink`: зовнішній отримувач, який поводиться як
сумлінний сервіс (один ефект на `Idempotency-Key`, відповідь через 300 мс). Він також скорочує lease воркерів до
5 с. Скрипт `apps/api/scripts/chaos-kill-worker.ts` створює тенанта й workflow
`log → http (sink) → delay 2 с → log` і ставить 200 виконань. Потім двічі вбиває один із воркерів
(`docker kill --signal KILL`, без graceful shutdown) і за 3 с запускає його знову. Після
завершення всіх виконань він перевіряє БД і лічильники отримувача та завершується з ненульовим
кодом, якщо щось не так, зокрема якщо вбивства не перервали жодної задачі (тоді сценарій нічого не довів).
Той самий сценарій виконується в CI (job `compose`).

Результат (локально, 18.11.2026):

| Показник | Значення |
|---|---|
| Виконань поставлено | 200 |
| Убито воркерів (SIGKILL) | 2 |
| Час до завершення всіх виконань | 21,8 с |
| Виконань succeeded / failed | 200 / 0 |
| Рядків `step_runs` (очікується 800) | 800 |
| Кроків, що мали понад 1 спробу (усього / http) | 8 / 8 |
| Задач, повернутих reaper-ом (lease минув) | 8 |
| Задач у стані `dead` | 0 |
| Запитів до отримувача / унікальних ефектів | 208 / 200 |
| Ключів, що прийшли повторно (і не дали другого ефекту) | 8 |

Що видно: вбивства перервали 8 задач посеред http-кроку. Reaper повернув їх після lease, і інші
воркери продовжили з того самого кроку (не з початку: рядків `step_runs` рівно 4 на виконання).
Повторні 8 запитів прийшли з тим самим `Idempotency-Key` і нового ефекту не дали. Пауза 2 с
пережила перезапуск воркерів, бо час пробудження зберігається в БД.

### Перезапуск Postgres під навантаженням (3.3.1–3.3.2)

```bash
# стек з оверлеєм — як вище
(cd apps/api && npm run chaos:postgres)
```

Скрипт `apps/api/scripts/chaos-restart-postgres.ts` ставить те саме навантаження (200 виконань
`log → http (sink) → delay 2 с → log`) і двічі робить `docker compose restart postgres`, чекаючи,
поки БД знову стане healthy. Перевіряє все те саме, що й сценарій із вбивством воркерів, і ще:
жоден процес воркера чи API не перезапустився (`StartedAt` і `RestartCount` контейнерів ті самі),
після відновлення всі вони знову healthy, а воркери справді бачили недоступність БД — є хоч один слід
збою: невдале захоплення чи продовження lease, обірваний запис результату (`job processing failed`)
або задача, повернута reaper-ом; інакше сценарій нічого не довів. (Перша версія рахувала лише
перші два сліди й у CI дала хибне «нічого не доведено»: обидва перезапуски застали всі цикли за
кроками, тож збій проявився лише обірваними записами й 11 поверненими задачами.) Той самий сценарій
виконується в CI (job `compose`).

Результат (локально, 18.11.2026):

| Показник | Значення |
|---|---|
| Перезапусків Postgres | 2 (разом 7,7 с до healthy) |
| Процесів воркерів і API, що перезапустились | 0 з 3 |
| Невдалих захоплень у логах воркерів (з backoff) | 1 |
| Невдалих продовжень lease у логах воркерів | 0 |
| Задач, чий запис обірвався (`job processing failed`) | 7 |
| Виконань поставлено | 200 |
| Час до завершення всіх виконань | 14,2 с |
| Виконань succeeded / failed | 200 / 0 |
| Рядків `step_runs` (очікується 800) | 800 |
| Кроків, що мали понад 1 спробу (усього / http) | 7 / 7 |
| Задач, повернутих reaper-ом (lease минув) | 7 |
| Задач у стані `dead` | 0 |
| Запитів до отримувача / унікальних ефектів | 207 / 200 |
| Ключів, що прийшли повторно (і не дали другого ефекту) | 7 |

Що видно: під час перезапуску обірвались з'єднання задач, що саме записували результат кроку.
Запис провалу теж не вдався (БД недоступна) — у логах воркерів 7 рядків `job processing failed`, тож
задачі лишились у `running`, і reaper повернув їх після lease. Повторні запити до отримувача прийшли з
тим самим `Idempotency-Key` і нового ефекту не дали (207 запитів, 200 ефектів). Захоплення під час
недоступності БД дало лише 1 рядок помилки на обидва воркери завдяки спільному відступу
(проблема 24). У CI (той самий сценарій) — 200/200, 205 запитів / 200 ефектів, 11 повернених задач.

Навантажувальний сценарій для справедливого планування — буде заповнено.

## Що не встигли або зробили б інакше

- **Вразливості залежностей (`npm audit`, 17.11.2026)** — деталі в підрозділі нижче. Нічого не
  оновлено: мажорні версії стартового коду (Nest 10, Next 14, TypeORM 0.3 тощо) не змінюємо, а
  виправлень у межах цих мажорних версій для досяжних вразливостей немає.
- Node.js 20 вже поза періодом підтримки (EOL — квітень 2026). Версію не змінювали за умовами
  роботи; перехід на актуальну LTS — окремим кроком.
- **Тимчасово:** верхня межа `SCHEDULER_TICK_MS` (2147483647 мс, ~24,8 доби) — лише захист
  від переповнення таймера Node (більше значення Node перетворює на 1 мс). Вона не обмежує
  запізнення cron: із тіком у добу щохвилинний розклад виконувався б раз на добу пачкою.
  Змістовна межа або відмова від фіксованого тіку — під час переробки планувальника (3.3.8).
- **Межа розміру відповіді кроку `http`** — зараз тіло відповіді читається повністю (ТЗ 3.3.6,
  розд. 4). За рішенням межа з'явиться разом із SSRF-захистом на undici (етап безпеки кроків, 3.3.6),
  а не в межах черги; до того пам'ять воркера від великої відповіді не захищена.
- **Опитування черги замість `LISTEN/NOTIFY`** — свідоме рішення: затримка захоплення в порожній
  черзі до `WORKER_POLL_INTERVAL_MS` (видно в `flowforge_job_claim_latency_seconds`) проти окремого
  постійного з'єднання на воркер, перепідключення й `NOTIFY` на кожну зміну черги.
- **Оновлення «на ходу»** — міграції виконуються до старту нових воркерів; одночасна робота старих
  воркерів із новою схемою не підтримується (див. «Міграції БД»).
- Решта — буде заповнено.

### Аудит залежностей (`npm audit`)

Перевірено 17.11.2026 (`npm audit` і `npm audit --omit=dev` в `apps/api` і `apps/frontend`).

| Застосунок | Усього | У runtime-залежностях | Critical / high у runtime |
|---|---|---|---|
| `apps/api` | 32 (3 low, 20 moderate, 9 high) | 15 (10 moderate, 5 high) | 0 / 5 |
| `apps/frontend` | 6 (1 moderate, 4 high, 1 critical) | 2 | 1 / 1 |

Решта — dev-залежності (`@nestjs/cli`, `@typescript-eslint/*`, `eslint-config-next`, `glob`,
`webpack`, `tmp` тощо): у runtime-образ API не потрапляють (`npm ci --omit=dev`), у образ
фронтенду — теж (копіюється лише `.next/standalone`), виконуються тільки під час збірки/лінту.

Runtime, critical/high — чи досяжні з нашого коду:

| Пакет (версія) | Через | Що | Досяжність | Рішення |
|---|---|---|---|---|
| `body-parser` 1.20.4 | `@nestjs/platform-express` (жорстко `1.20.4`) | GHSA-27r3-jxmh-p828: падіння процесу від байтів після стисненого тіла (виправлено в 1.20.9) | парсер працює на публічному порту до автентифікації. Відтворити на Node 20.19 не вдалося: сценарій з тесту виправлення upstream (deflate-кадр + байти після завершення декодера, keep-alive) і варіанти з gzip/deflate проти запущеного API — відповідь 200/400, процес живий | версію не змінено (виправлення лише через `overrides` або Nest 11+); застосовано обхід з advisory — `inflate: false`: стиснені тіла API не потрібні й тепер відхиляються з 415 до розпакування (проблема 30) |
| `multer` 2.0.2 | `@nestjs/platform-express` | DoS на multipart-завантаженнях | ні: `FileInterceptor`/multipart не використовуються, multer підключається лише ними | не змінено |
| `lodash` 4.17.21 | `@nestjs/config` (жорстко `4.17.21`) | `_.template`, prototype pollution у `_.unset`/`_.omit` | ні: `@nestjs/config` використовує лише `get`/`set`/`has` над змінними оточення | не змінено |
| `@nestjs/core` 10.4.22 | — | GHSA-36xv-jgw5-4q75 (moderate): ін'єкція подій у `@Sse` через `\n` у `type`/`id` | ні: SSE не використовується (уразливі всі версії до 11.1.17) | не змінено; якщо real-time буде на SSE — не передавати в `type`/`id` дані тенанта |
| `next` 14.2.35 | — | низка advisory (DoS RSC/Server Actions, Image Optimizer, cache poisoning, SSRF у rewrites/Server Actions) | 14.2.35 — остання версія 14.x, виправлення лише в 15/16. У фронтенді немає Server Actions, `next/image`, middleware, rewrites; App Router із серверними компонентами використовується, тож advisory щодо DoS RSC потенційно досяжні | не змінено (мажорна версія); у продакшені — оновлення Next або фронтенд лише за reverse proxy з лімітами |
| `postcss` | `next` | XSS у stringify, читання `.map` | ні: лише під час збірки CSS із нашого коду | не змінено |

Moderate з `npm audit fix` без `--force` (`file-type` через `@nestjs/common`, `qs` через
`body-parser`/`express`): `file-type` використовують лише валідатори завантаження файлів (не
використовуються); у `qs` уразливі `stringify` (а `isBuffer`-DoS — лише з `plainObjects`/`allowPrototypes`) і опція
`comma`, яких `express` для вхідних запитів не використовує. Оновлювати lock-файл заради недосяжних вразливостей не стали.
`npm audit fix --force` не запускався: він ставить мажорні версії (Nest 12, Next 16, TypeORM 1.x).
