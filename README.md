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

- `apps/api` — NestJS: HTTP API (`src/main.ts`), планувальник cron (у процесі API),
  окремий процес-воркер (`src/worker.ts`) зі службовим HTTP (`/health`, `/ready`, `/metrics`).
- `apps/frontend` — Next.js (App Router): ввід API-ключа, список workflow, сторінка виконання.
- `docker-compose.yml` — Postgres, одноразовий крок міграцій, API, два воркери, фронтенд.

## Запуск

```bash
docker-compose up --build
```

Порядок старту: `postgres` (healthy) → `migrate` (застосовує міграції й завершується з кодом 0)
→ `api` і два `worker` (healthy за `/ready`) → `frontend`. Схема БД будується лише міграціями,
тож система піднімається з порожнього тому.

| Сервіс | Адреса |
|---|---|
| API | http://localhost:3000 |
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

Створити тенанта (токен — `ADMIN_TOKEN` з `apps/api/.env.example`):

```bash
curl -X POST localhost:3000/tenants -H 'x-admin-token: change-me-admin' \
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
| GET | `/metrics` | метрики у форматі Prometheus |

Приклад workflow з кількома кроками:

```json
{
  "name": "demo",
  "steps": [
    { "id": "fetch", "type": "http", "url": "https://example.com/api?q={{ input.q }}" },
    { "id": "shape", "type": "transform", "expr": "ctx.steps.fetch.body" }
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
| `DATABASE_URL` | — (обов'язкова) | `postgres://user:pass@host:5432/db` |
| `ADMIN_TOKEN` | — (обов'язкова, ≥ 12 символів) | токен `POST /tenants` |
| `LOG_LEVEL` | `info` | рівень логування pino |
| `WORKER_CONCURRENCY` | `4` | паралельні цикли обробки в одному воркері |
| `WORKER_HTTP_PORT` | `3100` | службовий HTTP воркера |
| `SCHEDULER_TICK_MS` | `30000` | період тіку планувальника |
| `TEST_DATABASE_URL` | `postgres://flowforge:flowforge@localhost:5432/flowforge_test` | лише для інтеграційних тестів |

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

Для БД, створеної раніше через `synchronize`, базову міграцію треба позначити як застосовану
(рядок у таблиці `migrations`), а не виконувати повторно.

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
| `compose` | `docker compose up --build` з нуля: міграції, healthy API і обидва воркери, фронтенд |

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
  заповнено.
- **Health** — `GET /health` (liveness, без залежностей) і `GET /ready` (readiness: ping БД,
  `@nestjs/terminus`) в API і воркері; використовуються healthcheck-ами docker-compose.
- **Помилки** — глобальний фільтр (`src/observability/all-exceptions.filter.ts`): `HttpException`
  віддаються як є, будь-яка інша помилка — `{"statusCode":500,"message":"Internal server error"}`;
  до кожної відповіді з помилкою додається `correlationId`, деталі (стек, текст помилки БД) —
  лише в лог. `/ready` при недоступній БД не розкриває адресу чи причину.

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

- `/metrics` не захищений автентифікацією: у compose порт API опублікований назовні. Для
  продакшену — окремий внутрішній порт або токен для збирача метрик.
- Базова міграція зберігає схему стартового коду як є, зокрема `createdAt` типу `timestamp`
  без часового поясу; зміна типу — окремою міграцією, якщо знадобиться.
- Node.js 20 вже поза періодом підтримки (EOL — квітень 2026). Версію не змінювали за умовами
  роботи; перехід на актуальну LTS — окремим кроком.
- Решта — буде заповнено.
