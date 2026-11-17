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
6. [Спостережуваність](#спостережуваність)
7. [Знайдені проблеми](#знайдені-проблеми)
8. [Зміни наявних тестів](#зміни-наявних-тестів)
9. [Архітектурні рішення](#архітектурні-рішення)
10. [Модель гарантій виконання](#модель-гарантій-виконання)
11. [Потік виконання і межі транзакцій](#потік-виконання-і-межі-транзакцій)
12. [Індекси і плани запитів](#індекси-і-плани-запитів)
13. [Chaos- і навантажувальні сценарії](#chaos--і-навантажувальні-сценарії)
14. [Що не встигли або зробили б інакше](#що-не-встигли-або-зробили-б-інакше)

## Склад

- `apps/api` — NestJS: HTTP API (`src/main.ts`) зі службовим портом метрик, планувальник cron
  (у процесі API), окремий процес-воркер (`src/worker.ts`) зі службовим HTTP (`/health`, `/ready`,
  `/metrics`).
- `apps/frontend` — Next.js (App Router): ввід API-ключа, список workflow, сторінка виконання.
- `docker-compose.yml` — Postgres, одноразовий крок міграцій, API, два воркери, фронтенд.

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

### Основні ендпоінти

| Метод | Шлях | Опис |
|---|---|---|
| POST | `/tenants` | створення тенанта (`x-admin-token`) |
| POST/GET/PATCH/DELETE | `/workflows[/:id]` | керування workflow |
| POST | `/workflows/:id/run` | запуск вручну (тіло — input) |
| GET | `/executions`, `/executions/:id` | виконання та їхні кроки |
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
| `DATABASE_URL` | — (обов'язкова) | `postgres://user:pass@host:5432/db` |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | таймаут встановлення з'єднання з Postgres, 100..60000 мс (і для CLI міграцій) |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | межа одного SQL-запиту (`statement_timeout`) і простою відкритої транзакції (`idle_in_transaction_session_timeout`), 100..600000 мс; на CLI міграцій не діє |
| `ADMIN_TOKEN` | — (обов'язкова, ≥ 12 символів) | токен `POST /tenants`; у `NODE_ENV=production` приклад і очевидні заглушки заборонені (див. нижче) |
| `LOG_LEVEL` | `info` | рівень логування pino |
| `WORKER_CONCURRENCY` | `4` | паралельні цикли обробки в одному воркері |
| `WORKER_HTTP_PORT` | `3100` | службовий HTTP воркера |
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

Команди беруть `DATABASE_URL` і `DB_CONNECT_TIMEOUT_MS` з оточення або з `apps/api/.env` (решта
конфігурації застосунку CLI не потрібна). `statement_timeout` на міграції не діє: зміна схеми
великої таблиці легітимно триває довше за запит застосунку.

Для БД, створеної стартовим кодом через `synchronize`, базову міграцію не виконують повторно
(таблиці вже є), а позначають як застосовану, після чого застосовують решту:

```bash
# з кореня репозиторію (БД у compose)
docker-compose exec -T postgres psql -U flowforge -d flowforge -c \
  "CREATE TABLE IF NOT EXISTS migrations (id SERIAL PRIMARY KEY, \"timestamp\" bigint NOT NULL, name varchar NOT NULL);
   INSERT INTO migrations (\"timestamp\", name) VALUES (1794920217603, 'InitialSchema1794920217603');"
cd apps/api && npm run build && npm run migration:run
```

Перевірено на БД, створеній стартовим кодом: після цього застосовуються лише `AddCorrelationId` і
`TimestampsWithTimeZone`, а `migration:generate --check` не знаходить розбіжностей між схемою і
сутностями.

## Тести

```bash
cd apps/api
npm test                    # unit (без БД)
npm run test:integration    # integration на реальному Postgres
npm run test:all            # обидва набори
```

- `test/unit` — швидкі тести без інфраструктури (`test/jest-unit.json`).
- `test/integration` — тести на реальному Postgres (`test/jest-integration.json`). Перед
  прогоном глобальний setup створює базу `flowforge_test` (якщо її немає), **видаляє схему
  `public` і будує її міграціями з нуля** — тож кожен прогін заодно перевіряє міграції.
  Запуск дозволений лише на базі з суфіксом `_test`. Файли виконуються послідовно; кожен тест
  очищає таблиці (`test/helpers/db.ts`). Локально достатньо `docker-compose up -d postgres`.
- `test/helpers` — підготовка БД, створення тенантів/workflow, запуск справжнього
  Nest-застосунку на випадковому порту (`startApp`).

CI (`.github/workflows/ci.yml`):

| Job | Що перевіряє |
|---|---|
| `api` | lint, typecheck, unit, build |
| `integration` | інтеграційні тести з `services: postgres` |
| `frontend` | lint, build |
| `compose` | `docker compose up --wait` з нуля: міграції, healthy API, рівно два healthy воркери і фронтенд, запуск workflow наскрізь (виконання `succeeded` зі збереженим `correlationId`) |

Усі job-и мають `timeout-minutes`; у `compose` очікування готовності обмежене `--wait-timeout 180`,
а кожен `curl` — `--max-time`, тож сервіс, що прийняв з'єднання й мовчить, валить job за таймаутом,
а не тримає його до 6-годинного ліміту GitHub.

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
  процесу Node.js; доменні метрики реєструються в тому ж реєстрі (`MetricsService`) — буде
  заповнено. Метрики віддаються лише на службових портах, які docker-compose не публікує:
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

`job-queue.spec.ts` містить два `it.todo` («claims each job exactly once…», «re-queues a job
whose worker died…»): вони нічого не перевіряють, але звіт Jest рахує їх у загальній кількості
тестів. Залишені як явні маркери непокритої поведінки; відповідні інтеграційні тести — буде
заповнено (надійна черга).

Решта знахідок — буде заповнено.

## Зміни наявних тестів

| Файл | Зміна | Обґрунтування |
|---|---|---|
| `test/definition.spec.ts`, `test/template.spec.ts`, `test/job-queue.spec.ts` | перенесено в `test/unit/`, змінено лише відносні шляхи імпорту | розділення unit / integration на окремі конфігурації Jest; зміст тестів не змінено |
| `test/executions.service.spec.ts` | видалено, замінено на `test/integration/executions-tenant-isolation.int-spec.ts` | тест проходив незалежно від наявності фільтра за тенантом (проблема 1) |
| конфігурація Jest у `package.json` | винесено в `test/jest-unit.json` і `test/jest-integration.json` | старий `testRegex` збирав як тести будь-які файли в `test/`, зокрема хелпери |

## Архітектурні рішення

### Фундамент

**Схема БД: міграції замість `synchronize`.**
Варіанти: `synchronize: true` (як у стартовому коді); `migrationsRun` при старті кожного
процесу; окремий крок міграцій перед стартом. Обрано окремий крок (`migrate` у compose, CLI
TypeORM): `synchronize` може мовчки видалити колонку з даними при зміні сутності, а кілька
інстансів, що стартують одночасно, змагаються за зміну схеми; `migrationsRun` у кожному
процесі має ту саму гонку. Відповідність міграцій сутностям перевіряє інтеграційний тест
(«no drift»), відкат — тест revert/re-apply. Обмеження: нову міграцію треба вручну додати в
`migrations/index.ts`; міграції без даних (backfill) поки не знадобилися.

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

### 3.3.1 Надійна черга — буде заповнено

### 3.3.2 Durable execution — буде заповнено

### 3.3.3 Довговічні таймери — буде заповнено

### 3.3.4 Ізоляція тенантів у глибину — буде заповнено

### 3.3.5 Справедливе планування — буде заповнено

### 3.3.6 Безпечне виконання кроків — буде заповнено

### 3.3.7 Вхідні webhook-и — буде заповнено

### 3.3.8 Планувальник — буде заповнено

## Модель гарантій виконання

Що гарантується для кроку, виконання і вихідної події (at-least-once / at-most-once /
effectively-once) і за яких умов — буде заповнено.

## Потік виконання і межі транзакцій

Діаграма тригер → виконання → задача → крок → результат — буде заповнено.

## Індекси і плани запитів

Індекси для захоплення задач, списків виконань за тенантом і ключів ідемпотентності з
перевіркою через `EXPLAIN` — буде заповнено.

## Chaos- і навантажувальні сценарії

Як відтворити і що спостерігалось — буде заповнено.

## Що не встигли або зробили б інакше

- Node.js 20 вже поза періодом підтримки (EOL — квітень 2026). Версію не змінювали за умовами
  роботи; перехід на актуальну LTS — окремим кроком.
- **Тимчасово:** верхня межа `SCHEDULER_TICK_MS` (2147483647 мс, ~24,8 доби) — лише захист
  від переповнення таймера Node (більше значення Node перетворює на 1 мс). Вона не обмежує
  запізнення cron: із тіком у добу щохвилинний розклад виконувався б раз на добу пачкою.
  Змістовна межа або відмова від фіксованого тіку — під час переробки планувальника (3.3.8).
- Решта — буде заповнено.
