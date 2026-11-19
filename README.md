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
14. [Chaos- і навантажувальні сценарії](#chaos--і-навантажувальні-сценарії) (зокрема справедливе планування)
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
# один раз: випадкові секрети в .env поруч із docker-compose.yml (файл у .gitignore);
# права 0600 — до запису секретів, тож інші локальні користувачі файл не прочитають
touch .env && chmod 600 .env
for v in ADMIN_TOKEN POSTGRES_PASSWORD API_DB_PASSWORD WORKER_DB_PASSWORD; do
  printf '%s=%s\n' "$v" "$(openssl rand -hex 24)"; done > .env
docker-compose up --build
```

Секрети — лише з `.env` у корені (або зі змінних оточення); без будь-якого з них compose
завершується з підказкою. Шаблон — `.env.example` у корені. Кожен сервіс отримує тільки свої:

| Секрет | Хто отримує | Навіщо |
|---|---|---|
| `POSTGRES_PASSWORD` | `postgres`, `migrate` | власник схеми — суперкористувач `flowforge`: міграції й створення ролей |
| `API_DB_PASSWORD` | `migrate`, `api` | роль `flowforge_api` (без BYPASSRLS), якою API ходить у БД |
| `WORKER_DB_PASSWORD` | `migrate`, `worker` | роль `flowforge_worker` (без BYPASSRLS), якою ходить воркер |
| `ADMIN_TOKEN` | лише `api` | службові ендпоінти `/tenants…` |

Compose запускає API й воркери з `NODE_ENV=production`: приклад `change-me-admin` чи очевидна
заглушка зупиняють API помилкою валідації (див. «Конфігурація»). Паролі ролей — лише латинські
літери й цифри (щонайменше 24), бо потрапляють у URL підключення; `openssl rand -hex 24` підходить.
CI перевіряє розподіл секретів за сервісами через `docker inspect` (job `compose`).

Порядок старту: `postgres` (healthy) → `migrate` (застосовує міграції власником схеми, потім
`db:provision` створює або оновлює runtime-ролі `flowforge_api` і `flowforge_worker`, і
завершується з кодом 0) → `api` і два `worker` (healthy за `/ready`; кожен перед стартом перевіряє,
що його роль не обходить RLS, див. 3.3.4) → `frontend` (healthy, коли відповідає сторінка).
`docker-compose up -d --wait` повертає керування, коли всі сервіси healthy (або з помилкою). Схема БД будується лише міграціями,
тож система піднімається з порожнього тому.

| Сервіс | Адреса |
|---|---|
| API | http://localhost:3000 (`/metrics` тут немає — 404) |
| Метрики API | лише в мережі compose: `http://api:3200/metrics` |
| Фронтенд | http://localhost:3001 |
| Postgres | лише `127.0.0.1:5432` (власник `flowforge`, пароль — `POSTGRES_PASSWORD` із `.env`) |
| Воркери | лише в мережі compose, порт `3100` (`/health`, `/ready`, `/metrics`) |

### Локальний запуск поза docker

Потрібні Node.js 20.12+ (гілка 20) або 21.7+ (21 і новіші), Docker (для Postgres) та `.env` у корені з розділу вище. Діапазон Node.js — `engines` у `apps/api/package.json`: команди нижче й CLI міграцій читають `.env` через `util.parseEnv`, якого немає в 20.0–20.11 і 21.0–21.6. Якщо compose-стек
уже запущено, звільніть порти: `docker-compose stop api worker frontend`.

```bash
# з кореня репозиторію
env -i HOME="$HOME" PATH="$PATH" bash -eu <<'LOCAL_API'
docker-compose up -d postgres
cd apps/api
cp .env.example .env              # несекретні налаштування; секрети — нижче, окремо для процесу
npm ci
npm run build
setting() {
  node -e 'const {parseEnv}=require("node:util"), {readFileSync}=require("node:fs");
    process.stdout.write(parseEnv(readFileSync("../../.env","utf8"))[process.argv[1]] ?? "")' "$1"
}
# міграції й ролі — власником схеми (лише цим командам, не API й воркеру)
MIGRATION_DATABASE_URL="postgres://flowforge:$(setting POSTGRES_PASSWORD)@localhost:5432/flowforge" \
  npm run db:migrate
MIGRATION_DATABASE_URL="postgres://flowforge:$(setting POSTGRES_PASSWORD)@localhost:5432/flowforge" \
  API_DB_PASSWORD="$(setting API_DB_PASSWORD)" WORKER_DB_PASSWORD="$(setting WORKER_DB_PASSWORD)" \
  TENANT_MAX_RUNNING="$(setting TENANT_MAX_RUNNING)" TENANT_MAX_QUEUE_SIZE="$(setting TENANT_MAX_QUEUE_SIZE)" \
  TENANT_RATE_LIMIT="$(setting TENANT_RATE_LIMIT)" TENANT_RATE_WINDOW_MS="$(setting TENANT_RATE_WINDOW_MS)" \
  TENANT_WEBHOOK_RATE_LIMIT="$(setting TENANT_WEBHOOK_RATE_LIMIT)" TENANT_WEBHOOK_RATE_WINDOW_MS="$(setting TENANT_WEBHOOK_RATE_WINDOW_MS)" \
  npm run db:provision
# API на :3000 — своєю роллю
DATABASE_URL="postgres://flowforge_api:$(setting API_DB_PASSWORD)@localhost:5432/flowforge" \
  ADMIN_TOKEN="$(setting ADMIN_TOKEN)" npm run start
LOCAL_API
```

Метрики API — `curl localhost:3200/metrics` (службовий порт `METRICS_PORT`).
Воркер — в іншому терміналі, з `apps/api`, своєю роллю (службовий HTTP на `:3100`):

```bash
env -i HOME="$HOME" PATH="$PATH" bash -eu <<'LOCAL_WORKER'
worker_password="$(node -p 'require("node:util").parseEnv(require("node:fs").readFileSync("../../.env","utf8")).WORKER_DB_PASSWORD')"
DATABASE_URL="postgres://flowforge_worker:$worker_password@localhost:5432/flowforge" \
  npm run start:worker
LOCAL_WORKER
```

Застосунок і CLI міграцій читають `apps/api/.env` (якщо файл є); змінні, задані в оточенні
(як у docker-compose), мають пріоритет над файлом. Облікові дані власника (`MIGRATION_DATABASE_URL`)
у `apps/api/.env` не кладіть: API й воркер з ними не стартують (див. 3.3.4).

### Оновлення з попередньої версії

Том `pgdata`, створений попередньою версією (до ізоляції тенантів), оновлюється так (з кореня
репозиторію, `.env` з чотирма секретами — як у «Запуск»):

```bash
docker-compose stop api worker frontend   # старі процеси не працюють під час міграції
docker-compose up -d postgres
# POSTGRES_PASSWORD діє лише для порожнього тому: власнику наявного тому пароль змінюють один раз.
# Через локальний сокет контейнера старий пароль не потрібен; \password рахує verifier на клієнті,
# тож пароль не потрапляє в лог Postgres. Введіть значення POSTGRES_PASSWORD із .env.
docker-compose exec postgres psql -U flowforge -d flowforge -c '\password flowforge'
docker-compose up --build --wait
```

Міграція `TenantIsolation` перед змінами перевіряє цілісність наявних даних і зупиняється з
кількістю порушень (без самих даних), якщо знайде задачу чи крок без свого виконання, рядок
невідомого тенанта або посилання між тенантами (див. «Міграції БД»).

Перевірено (18.11.2026) на томі, створеному попередньою версією (стан після PR 2, e2fadbf), з даними
через її API: два тенанти, по 5 виконань (3 успішні workflow, який потім видалено, 1 провалене, 1 на
паузі `delay` 60 с). Після кроків вище: міграції й ролі застосовані, усі сервіси healthy; кожен
тенант через API бачить лише свої 5 виконань; усі 18 кроків отримали тенанта свого виконання; історія
видаленого workflow (6 виконань) збереглась; обидва виконання на паузі після оновлення продовжились і
завершились (`succeeded` 8, `failed` 2). Повторено з усіма міграціями цього PR (облік і ліміти
тенантів): облік обох тенантів після backfill дорівнює їхнім задачам, задачі на паузі захоплено й
завершено новим справедливим захопленням, `db:provision` записав ліміти за замовчуванням.

Фронтенд — з кореня репозиторію, в іншому терміналі:

```bash
cd apps/frontend
cp .env.example .env.local
sed -i.bak 's#http://api:3000#http://localhost:3000#' .env.local
npm ci
npm run dev -- -p 3001
```

### Приклади запитів

Створити тенанта з кореня репозиторію. Для обох способів запуску токен `ADMIN_TOKEN` береться з кореневого `.env`.

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

Ліміти тенанта (3.3.4): перевизначення — під час створення або пізніше (`null` — значення за
замовчуванням); відповідь показує перевизначення й ефективні ліміти.

```bash
curl -X POST localhost:3000/tenants -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"acme","limits":{"maxConcurrentExecutions":3,"rateLimit":100}}'
curl -X PATCH localhost:3000/tenants/<tenantId>/limits -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"maxQueueSize":5000,"rateLimit":null}'
curl localhost:3000/tenants/<tenantId>/limits -H "x-admin-token: $ADMIN_TOKEN"
```

Кожна відповідь, що пройшла через ліміт частоти, має `X-RateLimit-Limit`, `X-RateLimit-Remaining`
і `X-RateLimit-Reset` (секунди до кінця вікна). Два різні 429:

```text
HTTP/1.1 429 Too Many Requests              ← частота запитів
Retry-After: 37
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 0
{"statusCode":429,"error":"rate_limited","message":"забагато запитів; повторіть через 37 с","correlationId":"…"}

HTTP/1.1 429 Too Many Requests              ← черга тенанта заповнена (без Retry-After)
X-RateLimit-Remaining: 412
{"statusCode":429,"error":"queue_full","message":"черга тенанта заповнена: не більше 100000 незавершених задач; повторіть, коли задачі завершаться","correlationId":"…"}
```

### Основні ендпоінти

| Метод | Шлях | Опис |
|---|---|---|
| POST | `/tenants` | створення тенанта (`x-admin-token`; необов'язково `limits`) |
| GET/PATCH | `/tenants/:id/limits` | ліміти тенанта: перевизначення й ефективні значення (`x-admin-token`) |
| POST/GET/PATCH/DELETE | `/workflows[/:id]` | керування workflow |
| POST | `/workflows/:id/run` | запуск вручну (тіло — input; необов'язковий заголовок `Idempotency-Key`) |
| GET | `/executions`, `/executions/:id` | виконання та їхні кроки |
| POST | `/executions/:id/retry` | повтор виконання `failed` з першого незавершеного кроку (202; не `failed` — 409, чуже — 404) |
| POST | `/hooks/:workflowId` | вхідний webhook v1, timestamp, ID доставки й HMAC (3.3.7) |
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
одиночним сурогатом UTF-16 — 400: Postgres таких рядків не зберігає (проблема 22). Вкладеність
JSON (об'єкти й масиви) у тілі — до 64 рівнів, глибше — 400 (проблема 32).

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
| `DATABASE_URL` | — (обов'язкова, секрет) | підключення процесу **його власною роллю** без BYPASSRLS: API — `flowforge_api`, воркер — `flowforge_worker` (`postgres://<роль>:<пароль>@host:5432/db`); у `.env.example` лише закоментована підказка, compose задає її кожному сервісу окремо. Процес не стартує з роллю, що обходить RLS (3.3.4) |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | таймаут встановлення з'єднання з Postgres, 100..60000 мс (і для CLI міграцій) |
| `DB_POOL_SIZE` | `10` | найбільше з'єднань із Postgres в одному процесі, 5..1000, не менше за `WORKER_CONCURRENCY + 4` (проблема 25); сума пулів усіх процесів має вміщатися в `max_connections` Postgres (100 за замовчуванням) |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | межа одного SQL-запиту (`statement_timeout`) і простою відкритої транзакції (`idle_in_transaction_session_timeout`), 100..600000 мс; на CLI міграцій не діє |
| `ADMIN_TOKEN` | — (обов'язкова лише для API, ≥ 12 символів, секрет) | токен службових ендпоінтів `/tenants…`; воркер його не отримує й без нього стартує; у `NODE_ENV=production` приклад і очевидні заглушки заборонені (див. нижче); у `.env.example` — закоментована підказка |
| `ADMIN_RATE_LIMIT` / `ADMIN_RATE_WINDOW_MS` | `30` / `60000` | запитів до `/tenants…` з однієї IP-адреси за вікно (1..10000 / 1000..3600000 мс); рахується кожен запит ще до перевірки токена |
| `AUTH_FAILURE_RATE_LIMIT` / `AUTH_FAILURE_RATE_WINDOW_MS` | `30` / `60000` | невдалих автентифікацій (невірний `x-api-key`, невірний підпис webhook-а, webhook невідомому чи вимкненому workflow) з однієї IP-адреси за вікно; понад це — 429 замість 401/404, успішні запити не рахуються |
| `TRUST_PROXY` | `false` | звідки брати IP клієнта для лімітів за IP: `false` — адреса з'єднання; кількість проксі-переходів `1..10` або перелік IP/підмереж проксі через кому — з `X-Forwarded-For` лише від них. `true` не приймається: тоді клієнт сам задавав би свою IP |
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

**Змінні кроку міграцій** (`migrate` у compose; не входять до конфігурації API й воркера, а
`MIGRATION_DATABASE_URL` у їхньому оточенні — помилка валідації):

| Змінна | За замовчуванням | Опис |
|---|---|---|
| `MIGRATION_DATABASE_URL` | — (обов'язкова для `migration:*` і `db:provision`) | власник схеми — **суперкористувач** Postgres: міграції створюють роль із BYPASSRLS і заповнюють таблиці під `FORCE ROW LEVEL SECURITY`, що інакше не бачило б рядків |
| `API_DB_USER` / `API_DB_PASSWORD` | `flowforge_api` / — | login-роль API; `db:provision` створює її або оновлює пароль (ротація) |
| `WORKER_DB_USER` / `WORKER_DB_PASSWORD` | `flowforge_worker` / — | login-роль воркера; ім'я має відрізнятися від ролі API |
| `TENANT_MAX_RUNNING` | `10` | ліміт одночасних задач тенанта за замовчуванням, 1..1000 |
| `TENANT_MAX_QUEUE_SIZE` | `100000` | ліміт незавершених задач тенанта за замовчуванням, 1..10000000 |
| `TENANT_RATE_LIMIT` / `TENANT_RATE_WINDOW_MS` | `600` / `60000` | запитів тенанта до API за вікно, 1..1000000 / 1000..3600000 мс |
| `TENANT_WEBHOOK_RATE_LIMIT` / `TENANT_WEBHOOK_RATE_WINDOW_MS` | `600` / `60000` | webhook-ів тенанта за вікно (окрема квота) |

Значення `TENANT_*` `db:provision` записує в таблицю `limit_defaults` — одне джерело для API і
воркера (env цих процесів їх не містить, тож розійтися між процесами вони не можуть); у compose —
з кореневого `.env` (необов'язково, див. `.env.example`). Перевизначення окремого тенанта — адмін-API.

Пароль ролі — лише `[A-Za-z0-9]`, 24..256 символів (потрапляє в URL). `db:provision` передає
серверу не пароль, а SCRAM-SHA-256 verifier, обчислений на клієнті (як `psql \password`), тож пароль
не потрапляє ні в лог Postgres, ні в `pg_stat_statements`. Керувати суперкористувачем, власником
схеми чи груповими ролями він відмовляється.

**Адмін-токен і `NODE_ENV`.** `apps/api/.env.example` — несекретні налаштування для локальної
розробки (`NODE_ENV=development`); секрети в ньому закоментовані, для `ADMIN_TOKEN` підказано
`change-me-admin`. У `NODE_ENV=production` валідація
відхиляє `ADMIN_TOKEN`, що містить `change-me`/`changeme`, `example`, `placeholder`, `default`,
`password`, `secret`, `qwerty`, `12345` або має менше 8 різних символів; саме значення в помилці не
друкується. docker-compose бере `apps/api/.env.example` як основу (без секретів), задає
`NODE_ENV=production`, а секрети — з кореневого `.env`, кожному сервісу лише його. Варіанти, що розглядались: окремий `NODE_ENV` для compose
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

Міграції виконує власник схеми — суперкористувач Postgres (`MIGRATION_DATABASE_URL`), а не
runtime-роль API чи воркера; без суперкористувача `TenantIsolation` зупиняється з поясненням.

`npm run db:migrate` (`src/database/migrate.ts`; крок `migrate` у compose) виконує всі невиконані
міграції в одній транзакції під advisory-локом і перед COMMIT звіряє каталог з інваріантами безпеки
(розділ 3.3.4, «Інваріанти безпеки»): порушення відкочує все. Звірка виконується й тоді, коли нових
міграцій немає. `migration:run` / `migration:revert` / `migration:show` лишаються для розробки (без
звірки). Нова міграція, що додає таблицю чи функцію в `public`, оновлює також `POSTURE` у
`src/tenancy/security-posture.ts`.

```bash
cd apps/api
npm run build
# значення — з кореневого .env, без виконання його оболонкою (як у «Локальний запуск поза docker»)
setting() {
  node -e 'const {parseEnv}=require("node:util"), {readFileSync}=require("node:fs");
    process.stdout.write(parseEnv(readFileSync("../../.env","utf8"))[process.argv[1]] ?? "")' "$1"
}
export MIGRATION_DATABASE_URL="postgres://flowforge:$(setting POSTGRES_PASSWORD)@localhost:5432/flowforge"
npm run db:migrate          # застосувати й звірити інваріанти безпеки (одна транзакція)
# створити/оновити ролі flowforge_api і flowforge_worker та значення лімітів за замовчуванням
API_DB_PASSWORD="$(setting API_DB_PASSWORD)" WORKER_DB_PASSWORD="$(setting WORKER_DB_PASSWORD)" \
  TENANT_MAX_RUNNING="$(setting TENANT_MAX_RUNNING)" TENANT_MAX_QUEUE_SIZE="$(setting TENANT_MAX_QUEUE_SIZE)" \
  TENANT_RATE_LIMIT="$(setting TENANT_RATE_LIMIT)" TENANT_RATE_WINDOW_MS="$(setting TENANT_RATE_WINDOW_MS)" \
  TENANT_WEBHOOK_RATE_LIMIT="$(setting TENANT_WEBHOOK_RATE_LIMIT)" TENANT_WEBHOOK_RATE_WINDOW_MS="$(setting TENANT_WEBHOOK_RATE_WINDOW_MS)" \
  npm run db:provision
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
- `TenantIsolation` — ізоляція тенантів у Postgres (3.3.4): групові ролі `flowforge_api_role`,
  `flowforge_worker_role` (без BYPASSRLS) і `flowforge_system` (BYPASSRLS, власник SECURITY
  DEFINER-функцій; усі три NOLOGIN, створюються ідемпотентно й не видаляються `down`, бо спільні для
  кластера; наявну роль з іншими атрибутами чи з сесіями міграція не змінює, а відмовляє); `step_runs."tenantId"` (заповнюється з виконання); композитні FK `jobs`/`step_runs` →
  `executions (id, "tenantId")` і `executions` → `workflow_versions (id, "tenantId")`, FK
  `"tenantId"` → `tenants`; `FORCE ROW LEVEL SECURITY` і політика `tenant_isolation` на шести
  тенантних таблицях; права ролей (README, «Операції → права»); `REVOKE CREATE ON SCHEMA public`.
  Перед змінами перевіряє цілісність даних (задачі й кроки без виконання, рядки невідомого тенанта,
  посилання між тенантами) і зупиняється з кількістю порушень; історія видаленого workflow і
  завершені виконання без знімку (дозволені раніше) лишаються валідними.
- `TenantUsage` веде облік черги, зайнятих слотів і ефективних квот тенанта.
- `TenantLimits` додає спільні лічильники частоти запитів і читання ефективних лімітів.
- `TenantQuotaConsistency` узгоджує кеш квот із перевизначеннями тенантів та оновлює індекс і функції промоції й очищення.
- `ScheduledTenants` додає пошук тенантів з увімкненими розкладами та частковий індекс за тенантом і workflow.
- `ScheduledOccurrences` зберігає час спрацювання cron і забезпечує його унікальність для workflow.
- `JobUsageTransitions` оновлює облік тенанта за одну зміну рядка при завершенні, повторній постановці або додаванні задачі. При вилученні задачі з черги перерахунок найранішого часу серіалізовано за тенантом.
- `ClaimBusyReport` (нова ревізія `claim_job`): дозрілий тенант, якого промоція пропустила через `SKIP LOCKED`, дає busy, а не «черга порожня»; рівно вичерпаний бюджет промоції без решти дозрілих одразу переходить до вибору задачі.
- `RateLimitLockTime` (нова ревізія `rate_limit_hit`): межа вікна ліміту частоти перевіряється за моментом після блокування рядка відра.
- `RateLimitInsertTime` відкриває вікно після захоплення або створення відра, зокрема після відкату конкурентної вставки.
- `RecoverCheckpoints` звіряє старі кроки із зафіксованою версією. Якщо неможливо встановити, яке визначення вже мало зовнішній ефект, міграція зберігає історію кроків і завершує виконання з помилкою. Для такого виконання `/retry` повертає 409. Перед новим запуском оператор звіряє збережені результати з отримувачем. Для вже успішного виконання міграція закриває залишену в черзі задачу.

Команди беруть `MIGRATION_DATABASE_URL` і `DB_CONNECT_TIMEOUT_MS` з оточення або з `apps/api/.env`
(решта конфігурації застосунку CLI не потрібна). `statement_timeout` на міграції не діє: зміна схеми
великої таблиці легітимно триває довше за запит застосунку.

Для БД, створеної стартовим кодом через `synchronize` (наприклад, том `pgdata` після запуску
стартового репозиторію в compose), базову міграцію не виконують повторно — таблиці вже є, і крок
`migrate` упав би. Її позначають як застосовану, решту міграцій застосовують тим самим образом,
що й compose, а вже потім піднімають систему. Усе — з кореня репозиторію, з `.env` з розділу
[«Запуск»](#запуск); Node.js на хості не потрібен:

```bash
docker-compose up -d postgres
docker-compose exec postgres psql -U flowforge -d flowforge -c '\password flowforge'  # див. «Оновлення з попередньої версії»
docker-compose exec -T postgres psql -U flowforge -d flowforge -c \
  "CREATE TABLE IF NOT EXISTS migrations (id SERIAL PRIMARY KEY, \"timestamp\" bigint NOT NULL, name varchar NOT NULL);
   INSERT INTO migrations (\"timestamp\", name) VALUES (1794920217603, 'InitialSchema1794920217603');"
docker-compose run --rm --build migrate
docker-compose up --build
```

Те саме з хоста — після кроків [«Локальний запуск поза docker»](#локальний-запуск-поза-docker)
до `npm run build` включно (залежності встановлено, `DATABASE_URL` у `apps/api/.env` вказує на
`localhost`): ті самі `psql`-команди, потім `npm run db:migrate` з `apps/api`.

Перевірено на БД, створеній стартовим кодом (і з даними в його форматі: дублікати `step_runs`,
задачі в черзі, виконання вже видаленого workflow): після цього застосовуються решта міграцій, від
`AddCorrelationId` до `RecoverCheckpoints`, а `migration:generate --check` не знаходить розбіжностей
між схемою і сутностями.

## Тести

```bash
cd apps/api
npm test                    # unit (без БД)
# тестова БД — власником; пароль — POSTGRES_PASSWORD із кореневого .env (без нього — flowforge, як у CI)
pw="$(node -e 'const {parseEnv}=require("node:util"), {existsSync, readFileSync}=require("node:fs");
  const f="../../.env"; process.stdout.write((existsSync(f) && parseEnv(readFileSync(f,"utf8")).POSTGRES_PASSWORD) || "")')"
export TEST_DATABASE_URL="postgres://flowforge:${pw:-flowforge}@localhost:5432/flowforge_test"
npm run test:integration    # integration на реальному Postgres (спершу збирає dist: тест падіння воркера запускає dist/worker.js)
npm run test:all            # обидва набори
```

- `test/unit` — швидкі тести без інфраструктури (`test/jest-unit.json`).
- `test/integration` — тести на реальному Postgres (`test/jest-integration.json`). Перед
  прогоном глобальний setup створює базу `flowforge_test` (якщо її немає), **видаляє схему
  `public` і будує її міграціями з нуля** — тож кожен прогін заодно перевіряє міграції.
  Запуск дозволений лише на базі з суфіксом `_test`. Файли виконуються послідовно; кожен тест
  очищає таблиці (`test/helpers/db.ts`). Локально достатньо `docker-compose up -d postgres` і
  адреси тестової БД власником (суперкористувачем) — `TEST_DATABASE_URL` з блоку вище (пароль
  береться з кореневого `.env`, тож блок працює й у новому терміналі).
- **Ролі в тестах — як у compose.** Глобальний setup після міграцій створює runtime-ролі
  `flowforge_api_test_<суфікс>` і `flowforge_worker_test_<суфікс>` (`provisionLoginRoles`, окремі від
  ролей compose імена, бо ролі спільні для кластера Postgres) з **випадковими на кожен прогін паролями**
  (передаються тестовим процесам через оточення), а global teardown видаляє ці ролі. На спільному
  кластері після тестів не лишається логінів із паролем із репозиторію, яким можна було б
  підключитися до інших БД, де `CONNECT` для `PUBLIC` відкритий за замовчуванням. Перервався прогін —
  лишаються ролі з невідомим паролем; наступний прогін змінить його. Тестові тригерні функції
  створюються без `EXECUTE` для `PUBLIC`, як і службові: інакше перевірка на старті не пустила б процес. Застосунок у тестах ходить у БД цими ролями
  (`test/helpers/integration-env.ts`; воркер — своєю, через провайдер `RUNTIME_DATABASE_URL`), а
  підготовка й перевірка даних — з'єднанням власника (`openTestDataSource`), яке обходить RLS.
- **Кластерні імена — з суфіксом прогону.** Усе, що тести створюють на рівні кластера (login-ролі,
  допоміжні ролі сценаріїв, тимчасові БД), отримує ім'я з `clusterScopedName(base)`
  (`test/helpers/test-env.ts`): суфікс — 8 символів sha256 від імені тестової БД. Два прогони з
  різними `TEST_DATABASE_URL` на одному кластері не змінюють паролів і не видаляють ролей одне
  одного, а прогін, що впав, лишає ролі з тим самим ім'ям, яке знайде наступний teardown. Групові
  ролі (`flowforge_api_role`, `flowforge_worker_role`, `flowforge_system`) спільні за задумом
  (3.3.4), тож сценарії, що на мить додають до них стороннього члена, видно й сусідньому прогону: на
  цей час його перевірки на старті й `db:migrate` відмовляють. Для повністю незалежних прогонів
  потрібні окремі кластери.
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
- Ізоляція тенантів (3.3.4): `tenant-isolation-api` (ключ тенанта B проти кожного ресурсу A),
  `rls` (прямий SQL під ролями API й воркера: без контексту, зі сміттєвим контекстом, у контексті
  іншого тенанта; заборонені операції; спроби обійти RLS; підміна імен через `pg_temp`),
  `tenant-predicates` (предикати сервісів з обійденим RLS), `db-acl` (точна матриця прав),
  `role-operations` (кожна операція справжніми ролями), `db-security-check` (відмова старту з
  небезпечною роллю), `tenant-context-pool` (контекст не переживає транзакцію в пулі), `provision`
  (ролі, SCRAM verifier, ротація пароля), `migration-data` (backfill і зупинка на порушеннях цілісності).
- Ліміти й справедливість (3.3.4–3.3.5): `tenant-limits` і `tenant-queue-limit` (ліміт черги для
  run, webhook, cron і `/retry`; ключ ідемпотентності під блокуванням), `rate-limit` (квота тенанта
  між маршрутами й інстансами API, окрема квота webhook-ів, вікно, недоступний лічильник),
  `rate-limit-ip` (адмін-ендпоінти, невдалі автентифікації, `TRUST_PROXY`), `tenant-limits-admin`
  (адмін-API, межі, значення з db:provision), `tenant-concurrency` (жорсткий ліміт одночасних
  задач), `fair-claim` (порядок обслуговування й межа за журналом захоплень), `claim-contention`
  (зайняті кандидати, самовідновлення обліку), `queue-consistency` (облік точно дорівнює задачам під
  змішаним навантаженням, без deadlock-ів), `queue-depth-metric`.
- Бенчмарк захоплення: `npm run bench:claim` (`test/bench`, окрема конфігурація Jest; відносні
  критерії й результати — «Chaos- і навантажувальні сценарії»).
- Перевірки часу в сценаріях черги спираються на факти з БД (`wakeAt`, `runAt`, `lockToken`,
  `attempts`) за годинником БД, а не на час процесу тесту.
- Стабільність (18.11.2026, локально): увесь інтеграційний набір — 10 прогонів поспіль на
  попередній ревізії PR2, 10/10 зелені (143 тести, 59–62 с на прогін). Перша така серія виявила одне падіння
  з п'яти (`worker-metrics`, гонка воркера з підготовкою даних тесту) — виправлено, див. «Зміни
  наявних тестів», і серії відтоді повторювались з нуля для того набору тестів.

CI (`.github/workflows/ci.yml`):

| Job | Що перевіряє |
|---|---|
| `api` | format:check, lint, typecheck, unit, build |
| `integration` | інтеграційні тести з `services: postgres`, потім бенчмарк захоплення (`npm run bench:claim`: відносно FIFO на тому самому раннері) |
| `frontend` | format:check, lint, build |
| `compose` | `docker compose up --wait` з нуля: міграції, healthy API, рівно два healthy воркери і фронтенд, кожен сервіс отримує лише свої секрети (`docker inspect`), runtime-ролі без суперкористувача й BYPASSRLS, запуск workflow наскрізь (виконання `succeeded` зі збереженим `correlationId`); потім chaos-сценарії (`npm run chaos`: SIGKILL воркерів під навантаженням; `npm run chaos:postgres`: перезапуск Postgres під навантаженням) і навантажувальний сценарій справедливого планування (`npm run load:fairness`, з критеріями) |

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
  | `flowforge_job_claim_duration_seconds` | histogram | тривалість одного захоплення (промоція, вибір тенанта й задачі) за годинником воркера |
  | `flowforge_claim_usage_repairs_total` | counter | рядки обліку тенантів, перераховані захопленням, бо розійшлись із задачами (за інваріантами — 0; інше значення — привід розбиратися) |
  | `flowforge_queue_depth{tenant_id,state}` | gauge | задачі тенанта в черзі (`queued`, включно з паузами) і в роботі (`running`) — серія для кожного тенанта з незавершеними задачами |
  | `flowforge_queue_depth_collect_errors_total` | counter | невдалі читання глибини черги: +1 на читання з БД, а не на кожен скрейп, що на нього чекав (тоді серій глибини немає, а не застарілі). Читання обмежене меншим із 2 с і `DB_STATEMENT_TIMEOUT_MS` |

  API: `flowforge_executions_retried_total` — виконання, поставлені на повтор через
  `POST /executions/:id/retry`; `flowforge_rate_limited_total{throttler}` — запити, відхилені 429
  лімітом частоти (`tenant`, `webhook`, `admin`, `auth-failures`);
  `flowforge_enqueue_rejected_total{reason,trigger}` — виконання, не створені через повну чергу
  тенанта (`reason="queue_full"`, `trigger` — `api`, `webhook`, `cron`, `retry`).

  **Глибина черги за тенантом** — з обліку `tenant_usage` (без сканування `jobs`), знімок кешується
  на 5 с, читання обмежене 2 с. Мітка `tenant_id` — єдина мітка з ідентифікатором: кардинальність
  дорівнює кількості тенантів із незавершеними задачами, тенант, що спорожнів, зникає на наступному
  зборі. Значення глобальні — кожна репліка воркера віддає однакові, тож агрегувати так:
  `max by (tenant_id, state) (flowforge_queue_depth)`. Решта міток — лише з фіксованого набору
  значень. Метрики віддаються лише на службових портах, які docker-compose не публікує:
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
- **Альтернативи.** Чинний guard перевіряє підпис на сирих байтах перед квотою й розбором JSON (3.3.7).

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
  наявних шаблонів (тенант може свідомо підставляти шлях із `/`). Застосовується обмеження підстановки та перевірка кінцевого URL (3.3.6).

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
  коли підказка перевищує випадковий backoff, задачі з однаковим `Retry-After` отримують
  однакову затримку, обмежену `JOB_BACKOFF_MAX_MS`. За меншої підказки діє випадкове
  значення backoff. Невалідний заголовок ігнорується. Межі перевіряє `test/unit/job-queue.spec.ts`.
- **Альтернативи.** Додати jitter поверх підказки означало б довше чекати після дозволеного
  часу повтору. Верхня межа захищає чергу від надмірно довгої паузи на вимогу отримувача.

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

- **Як виправлено.** `inflate: false` в обох парсерах Nest (JSON і URL-encoded): стиснене тіло цих типів — 415 без
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

### 32. Валідний глибоко вкладений JSON давав 500

- **Що.** Об'єкт `{"a":{"a":…}}` на 3000 рівнів (18 КБ, менше за ліміт тіла) у вході `/run`, у
  правильно підписаному webhook-у, у полі тіла `/workflows` чи у визначенні кроку переповнював стек
  рекурсивних обходів (`findUnstorable`, `JSON.stringify` для перевірки розміру й підпису,
  class-transformer) — `RangeError` і 500. З 10 000 рівнів (60 КБ) переповнювався вже
  `JSON.stringify` перед перевіркою підпису webhook-а: 500 отримував і неавтентифікований запит.
  Така сама відповідь отримувача в кроці `http` валила чекпоінт внутрішньою помилкою з повтором,
  тобто з повторним зовнішнім викликом.
- **Чому небезпечно.** 500 замість 400 на коректно сформованому вході (ТЗ, розд. 4: валідація на
  межі); дешевий запит, що стабільно валить обробник; повтор уже виконаного HTTP-ефекту.
- **Як відтворити.** `test/integration/json-depth.int-spec.ts`, `test/unit/storable-text.spec.ts`.

  ```text
  ✕ answers a run input nested 65 levels deep with 400 and creates nothing
    Expected: 400
    Received: 201
  ✕ answers a run input nested 3000 / 15000 levels deep with 400 and creates nothing
  ✕ answers a correctly signed webhook nested 3000 levels deep with 400
  ✕ answers a field of the workflow / a step definition nested 3000 levels deep with 400
    Expected: 400
    Received: 500
  ✕ answers an unsigned webhook nested 15000 levels deep with 401 and no details
  ✕ answers a webhook too deep to re-serialize for its signature with 401, not 500
    Expected: 401
    Received: 500
  ✕ fails an http step without retries when the response JSON is nested deeper than 2048 levels
  ✕ walks a value nested deeper than the call stack allows without throwing
  ```

- **Як виправлено.** `exceedsJsonDepth` (`src/common/json-depth.ts`) — ітеративний обхід із явним
  стеком; `findUnstorable` теж став ітеративним. Межа `MAX_JSON_DEPTH = 64` перевіряється раніше за
  будь-який рекурсивний обхід: у глобальному `ApiValidationPipe` для тіл-DTO, у `parseRunInput`
  (вхід `/run` і webhook-а) і `validateSteps`. Відповідь — 400 з поясненням. Пайпи виконуються після
  guard-ів, а webhook перевіряє вхід після підпису, тож неавтентифікований запит, як і раніше,
  отримує 401 без пояснень (проблема 18). Правильний підпис сирих байтів надглибокого тіла дає 400 на етапі перевірки входу. Результат кроку `http` має власну межу `MAX_STEP_RESULT_DEPTH = 2048`:
  відповідь глибша — неповторювана помилка кроку (повтор дав би той самий результат).
- **Альтернативи.** Перевірка глибини в body-parser-і для всіх запитів: спрацьовує до перевірки
  підпису webhook-а (повторило б проблему 18), а помилки з `verify` body-parser перетворює на 403.
  Ітеративні версії всіх обходів без межі: `JSON.stringify`, class-transformer і парсер `jsonb` у
  Postgres (20 000 рівнів — `stack depth limit exceeded`) не наші — межа однаково потрібна. Для
  результатів кроку межа вища, ніж для входу: відповідь задає не тенант, а глибину 2000 рівнів уже
  зберігає наявний тест (`unstorable-text.int-spec.ts`); 2048 утричі нижче за межу `JSON.stringify`
  у V8 і вчетверо — за межу `jsonb`.

### 33. Втрачена відповідь на старт кроку лишала крок `running` у завершеному виконанні

- **Що.** Якщо транзакція `startStep` закомітилась, а драйвер отримав помилку (обрив з'єднання
  після COMMIT), воркер не знав про розпочатий крок і передавав у `fail()` `undefined`. На останній
  спробі задача ставала `dead`, виконання — `failed`, а рядок кроку лишався `running` без
  `finishedAt`. Reaper завершених задач не бачить, тож стан не виправлявся ніколи. Підсумкова
  помилка ще й показувала лічильник спроб із пам'яті воркера (`0/1` замість `1/1`).
- **Чому небезпечно.** Суперечливий стан у БД: виконання завершене, а крок «ще виконується»; UI,
  метрики й аналіз інцидентів бачать неправду (ТЗ 3.3.2).
- **Як відтворити.** `test/integration/durable-execution.int-spec.ts` — `startStep` комітить у БД, після
  чого тест відхиляє його Promise; ліміт — одна спроба.

  ```text
  ✕ marks an http step failed when the acknowledgement of its start is lost on the last attempt
  ✕ marks a delay step failed when the acknowledgement of its start is lost on the last attempt
    Expected: "failed"
    Received: "running"
  ```

- **Як виправлено.** `CheckpointService.fail` спершу блокує задачу (`assertLease`), а потім позначає
  проваленим крок виконання зі статусом `running` за даними БД, а не за значенням, яке встиг
  отримати воркер. Під блокуванням із нашим lease рядки кроків змінює лише ця спроба, а кроки йдуть
  по черзі, тож такий рядок щонайбільше один. Лічильник спроб для тексту помилки — із заблокованого
  рядка задачі.
- **Альтернативи.** Повторно читати результат `startStep` у воркері після помилки: окремий запит
  поза блокуванням, що сам може загубитися. Прибирати такі рядки окремим проходом обслуговування:
  стан був би неправдивим до наступного проходу, а `fail()` уже тримає потрібне блокування.

### 34. `GET /executions/:id` віддавав виконання іншого тенанта

- **Що.** `ExecutionsController.get` не брав тенанта з ключа, а `ExecutionsService.get(id)` шукав
  виконання лише за `id`. Ключ тенанта B за id виконання тенанта A отримував 200 з усім виконанням:
  `input`, `output`, текстом помилок і кроками.
- **Чому небезпечно.** Прямий витік даних між тенантами (ТЗ 3.2, «Ізоляція даних між тенантами»):
  id виконань потрапляють у логи, webhook-и, повідомлення підтримки; UUID не є секретом доступу.
- **Як відтворити.** `test/integration/tenant-isolation-api.int-spec.ts` — ключ тенанта B проти
  кожного ресурсу тенанта A.

  ```text
  ✕ GET /executions/:id of another tenant is 404 and leaks nothing
    Expected: 404
    Received: 200
  ✓ GET /executions of tenant B does not list executions of A
  ✓ POST /executions/:id/retry of another tenant is 404 and changes nothing
  ✓ workflow endpoints of another tenant are 404 and change nothing
  ```

- **Як виправлено.** `get(tenantId, id)` з предикатом `"tenantId"` для виконання й кроків; чуже
  виконання — 404, як неіснуюче (без підказки, що id існує). Поверх цього — RLS (проблема 35): навіть
  забутий предикат більше не відкриває чужих рядків. Обидва шари доводяться окремо: з прибраним
  предикатом у сервісі HTTP-тест лишається зеленим завдяки RLS, але `tenant-predicates.int-spec.ts`
  (сервіси на з'єднанні, що обходить RLS) червоніє:

  ```text
  ✕ executions of A are invisible and cannot be retried by B
  ✓ GET /executions/:id of another tenant is 404 and leaks nothing
  ```

- **Альтернативи.** 403 замість 404: підтверджує існування чужого id. Guard, що перевіряє власника
  ресурсу окремим запитом перед обробником: подвоює запити й легко забувається для нових
  ендпоінтів; предикат у самому запиті й RLS під ним надійніші.

### 35. Ізоляція тенантів трималася лише на фільтрах у коді: застосунок ходив у БД суперкористувачем

- **Що.** API й воркер підключались ролью `flowforge` — суперкористувачем Postgres. Будь-який
  запит без `where: { tenantId }` (як у проблемі 34) бачив і міг змінити дані всіх тенантів; у БД не
  було ні RLS, ні обмежень, що не дали б рядку одного тенанта посилатися на виконання іншого
  (`jobs.tenantId` могла не збігатися з тенантом виконання, `step_runs` тенанта не мали взагалі).
- **Чому небезпечно.** ТЗ 3.3.4 вимагає захисту на рівні Postgres. З одним шаром кожна помилка в
  новому запиті — витік; суперкористувач до того ж обходить будь-які політики, які додали б пізніше.
- **Як відтворити.** `test/integration/rls.int-spec.ts` — прямий SQL тією самою роллю, що й застосунок
  (`DATABASE_URL`), на коді до виправлення:

  ```text
  ✕ a query without tenant context sees no rows of tenants … jobs                 (6 таблиць)
  ✕ a query with a malformed tenant context sees no rows of tenants … jobs        (6 таблиць)
  ✕ tenant A sees none of the rows of tenant B in tenants … jobs                  (6 таблиць)
  ✕ tenant A cannot change or delete rows of tenant B
  ✕ tenant A cannot create rows in the name of tenant B
  ✕ no row of one tenant can reference an execution of another, even when written by the owner
  Tests:       21 failed, 21 total
  ```

- **Як виправлено.** Міграція `TenantIsolation` і шар `src/tenancy` (рішення — 3.3.4): ролі API й
  воркера без BYPASSRLS, `FORCE ROW LEVEL SECURITY` і політика за `app.tenant_id` на кожній тенантній
  таблиці, композитні FK у межах тенанта, вузькі SECURITY DEFINER-функції для крос-тенантних кроків;
  кожен запит — у транзакції з транзакційно-локальним контекстом (`TenantDb`) і з явним предикатом;
  процес не стартує з роллю, що обходить RLS. Після виправлення — 50 перевірок `rls.int-spec.ts`
  зелені, плюс `db-acl`, `db-security-check`, `tenant-context-pool`, `role-operations`.
- **Альтернативи.** Див. 3.3.4: схема чи БД на тенанта, роль на тенанта, BYPASSRLS для воркера,
  контекст на рівні сесії.

### 36. Compose відкривав БД суперкористувачем із відомим паролем і давав воркеру `ADMIN_TOKEN`

- **Що.** `docker-compose.yml` задавав пароль суперкористувача `flowforge` прямо у файлі
  (`POSTGRES_PASSWORD: flowforge`, публічний репозиторій), публікував порт 5432 на всіх інтерфейсах і
  через спільний `env_file` + `environment` передавав `ADMIN_TOKEN` і URL суперкористувача кожному
  сервісу, зокрема воркерам, яким вони не потрібні.
- **Чому небезпечно.** Будь-хто в мережі хоста підключався до БД суперкористувачем з паролем із
  репозиторію й обходив будь-яку ізоляцію; компрометація воркера (він виконує кроки тенантів)
  давала адмін-токен і повний доступ до БД.
- **Як відтворити.** Перевірка job `compose` (`docker inspect` оточення контейнерів) на стеку до
  виправлення — значення приховано:

  ```text
  == flowforge-starter-worker-1
  ADMIN_TOKEN=…
  DATABASE_URL=postgres://flowforge:***@postgres:5432/flowforge
  == flowforge-starter-api-1
  DATABASE_URL=postgres://flowforge:***@postgres:5432/flowforge
  postgres ports: {"5432/tcp":[{"HostIp":"","HostPort":"5432"}]}
  flowforge | rolsuper = t
  ```

- **Як виправлено.** Секрети лише з кореневого `.env`, кожному сервісу — тільки його (таблиця в
  «Запуск»); `POSTGRES_PASSWORD` обов'язковий, порт БД — `127.0.0.1:5432`; API й воркер — своїми
  ролями; `ADMIN_TOKEN` обов'язковий лише для API (воркер його не отримує й без нього стартує);
  облікові дані власника в оточенні runtime-процесу — помилка валідації. CI перевіряє розподіл
  секретів і атрибути ролей (job `compose`).
- **Альтернативи.** Docker secrets (файли): потребують зміни способу читання конфігурації в обох
  процесах і не дають більшого захисту, ніж окремий `environment` кожного сервісу в compose;
  лишити порт закритим зовсім: локальний запуск і тести поза docker перестали б працювати.

### 37. Тенант із глибокою чергою відсував усіх інших (захоплення FIFO)

- **Що.** Захоплення брало найранішу готову задачу серед усіх тенантів (`ORDER BY "runAt"`). Тенант,
  що поставив у чергу тисячі задач, займав усі слоти воркерів, доки не вичерпається його черга, а
  задачі інших тенантів, поставлені пізніше, чекали на весь його backlog.
- **Чому небезпечно.** ТЗ 3.3.5: один тенант не повинен суттєво збільшувати затримку задач інших.
  Затримка тихого тенанта росла пропорційно чужій черзі — хвилини й години замість секунд.
- **Як відтворити.** `test/integration/fair-claim.int-spec.ts` на коді до виправлення:

  ```text
  ✕ alternates a lone ready tenant with a tenant holding 2000 older jobs, one slot, real completions
    - Expected  - 5
    + Received  + 5          (усі 10 захоплень — тенант A)
  ✕ claims each of 50 ready tenants once before any of them twice, one slot
    Expected: 50
    Received: 14
  ✕ lets tenant B finish while most of the backlog of tenant A still waits (several workers)
    Expected: > 2700
    Received:   0            (B завершився лише після всіх 3000 задач A)
  ```

- **Як виправлено.** Облік на тенанта (`tenant_usage`, тригери) і справедливе захоплення: тенант із
  найменшою кількістю задач у роботі, серед рівних — найдавніше обслужений, одним оператором
  `FOR UPDATE SKIP LOCKED` (рішення й гарантія — 3.3.5). Вимірювання — «Навантажувальний сценарій
  справедливого планування».
- **Альтернативи.** Див. 3.3.5: черга з пріоритетом за віком, глобальна серіалізація рішень,
  WFQ/DRR, очікування рядка кандидата.

### 38. Тенант не мав жодних лімітів: черга, частота запитів і задачі в роботі — без меж

- **Що.** Будь-який тенант міг ставити необмежено виконань (через API, webhook чи cron), робити
  необмежено запитів і займати всі слоти воркерів; невдалі спроби ключа чи адмін-токена теж ніщо не
  обмежувало.
- **Чому небезпечно.** ТЗ 3.3.4 вимагає лімітів одночасних виконань, розміру черги й частоти
  запитів; без них один тенант (навмисно чи помилкою інтеграції) вичерпує БД і воркери всіх.
- **Як відтворити.** `test/integration/tenant-limits.int-spec.ts` на коді до виправлення:

  ```text
  ✕ rejects a run beyond the queue size of the tenant with 429 queue_full and creates nothing
    Expected: 429
    Received: 201
  ✕ rejects requests beyond the request rate of the tenant with 429 rate_limited and Retry-After
    Expected: 429
    Received: 200
  ```

- **Як виправлено.** Ліміт одночасних задач — у захопленні (жорсткий, під блокуванням рядка обліку);
  ліміт черги — під час кожної постановки атомарно з нею (429 `queue_full`, нічого не створюється,
  cron пропускає спрацювання); частота — `@nestjs/throttler` зі сховищем у Postgres (429
  `rate_limited`, заголовки `X-RateLimit-*`), окремо для API тенанта, його webhook-ів, адмін-ендпоінтів
  і невдалих автентифікацій за IP. Значення за замовчуванням — `TENANT_*` (db:provision), перевизначення —
  адмін-API (3.3.4, «Ліміти тенанта»).
- **Альтернативи.** Див. 3.3.4: лічильник у пам'яті процесу (не працює між інстансами API), Redis
  (заборонений), окремий env кожного процесу (ліміти розходились би), `count(*)` на кожну постановку.

### Регресії ізоляції, квот і справедливості

Запуск з `apps/api` — `npm test -- --runInBand` для локального запуску, конфігурації та оцінки вимірювань. Решту сценаріїв виконує `npm run test:integration` на окремій PostgreSQL 16 з іменем БД, що закінчується на `_test`.

| Дефект і наслідок до виправлення | Як відтворити | Виправлення і розглянута альтернатива |
|---|---|---|
| Команди локального запуску, включно з `npm ci`, успадковували чотири секрети. Облікові дані власника БД потрапляли навіть до воркера | `local-start.spec.ts` запускає команди README з чотирма різними маркерами та перевіряє оточення кожної команди | Чиста оболонка, розбір кореневого dotenv через Node і явна передача потрібних значень. Список заборонених змінних довелося б оновлювати при кожному новому секреті |
| Створення тенанта під час зміни типових квот залишало попереднє значення у воркера. У тесті API вже мав ліміт 1, облік мав 1000 | `tenant-limits-admin.int-spec.ts` утримує транзакцію provisioning під час вставки. `migration-data.int-spec.ts` оновлює базу з розбіжністю і власним перевизначенням | Тригер читає рядок типових квот під `FOR SHARE`. Коригувальна міграція перераховує наявний облік. Повторне читання в API не синхронізувало б воркер |
| GET міг повернути різні версії перевизначень і ефективних квот. Масив вкладених лімітів створював тенанта з типовою квотою | `tenant-limits-admin.int-spec.ts` змінює квоту одразу після читання. HTTP-перевірки надсилають масив або невідоме вкладене поле та очікують 400 | Один SQL-запит для обох частин відповіді. Ключі перевіряються перед перетворенням DTO, форма — через `IsObject`. Підвищення рівня ізоляції усієї транзакції не потрібне для одного читання |
| Два паралельні входи в одну транзакцію могли обидва змінити контекст. CIDR з нульовим префіксом проходив валідацію, але зупиняв Express | `tenant-context-pool.int-spec.ts` одночасно входить із двома UUID і перевіряє повторне отримання того самого з’єднання. `env.validation.spec.ts` перевіряє IPv4 та IPv6 | UUID резервується до першого очікування БД, входи того самого тенанта чекають спільного результату. Конфіг приймає підтримувані межі префікса. Перевірки тільки у викликачів залишали б решту шляхів незахищеними |
| Provisioning міг змінити пароль ролі, яка вже мала власність, сторонні членства, права на стовпець або наперед встановлений контекст. Стартова перевірка бачила лише гранти на всю таблицю | `provision.int-spec.ts` перевіряє відмову до першої зміни ролі. `db-security-check.int-spec.ts` перевіряє старт із колонковим грантом на таблицю без RLS | Перевірки ролі, членств у двох напрямках, схемної власності, прав групи й налаштувань сесії. Фактичний доступ до стовпців перевіряється поряд з RLS. Автоматичне відкликання прав у наявної ролі могло б пошкодити інший сервіс |
| Насичені тенанти витісняли B з пакета промоції. Пошук дозрілих задач і очищення вікон лімітера переглядали індекс далі поточного моменту | `fair-claim.int-spec.ts` ставить перед B три пакети насичених тенантів. `query-plans.int-spec.ts` перевіряє часову межу в `Index Cond` і читання сторінок для 25 000 майбутніх розкладів задач | Вільний слот враховується у предикаті часткового індексу і до `LIMIT`. Пошук використовує час початку оператора, lease — годинник моменту захоплення. Більший пакет лише збільшив би кількість тенантів, потрібну для появи дефекту |
| Бенчмарк CI зафіксував 49,68% пропускної здатності FIFO при порозі 50%. Успішне завершення виконання вимагало трьох послідовних запитів після встановлення контексту тенанта | `tenant-predicates.int-spec.ts` рахує SQL-оператори та перевіряє відмову з чужим тенантом, виконанням чи токеном. `execution-atomicity.int-spec.ts` обриває останній запис тригером | Один оператор блокує задачу з чинним токеном, записує результат її виконання і завершує задачу. Залежності між CTE зберігають порядок блокувань. `query-plans.int-spec.ts` перевіряє під роллю воркера індексний пошук за ідентифікатором виконання. Бенчмарк окремо порівнює облік задачі й повний шлях завершення виконання |
| Завершення та повторна постановка задачі двічі шукали рядок обліку тенанта. У CI медіана для черги становила 875 задач/с проти 1755 у FIFO (49,86%) | `fair-claim.int-spec.ts` підраховує звернення до `tenant_usage` через `pg_stat_xact_user_tables`. `queue-consistency.int-spec.ts` звіряє облік з фактичними задачами під конкурентним навантаженням і відкатами | Для переходів у чергу та звільнення слота достатньо одного атомарного UPDATE. При вилученні найранішої задачі функція спочатку бере блокування, потім шукає новий мінімум на свіжому знімку |
| Помилка читання чекпоінтів утримувала слот до спливу lease | `durable-execution.int-spec.ts` перериває читання й перевіряє стан задачі одразу після спроби | Початкове читання виконання, знімка і чекпоінтів входить до штатного обробника повторів із перевіркою lease. Reaper повертає задачу, якщо сама БД недоступна для запису |
| Перед першим спрацюванням B планувальник читав усі розклади. Поділ обходу на сторінки виявив повтор уже записаного спрацювання при помилці наступної сторінки | `scheduled-fairness.int-spec.ts` ставить B після 1200 розкладів A. Другий сценарій перериває пізнішу сторінку та повторює той самий тік | Keyset за тенантами, порції до 16 workflow під RLS та чергування тенантів. Час спрацювання фіксується разом з execution і job. Глобальне завантаження всіх workflow витрачає пам’ять і відкладає першу постановку |
| Навантажувальний сценарій міг пройти без прогонів, із неповною контрольною фазою або після скидання метрик. Помилка вимірювання лишала backlog | `load-fairness.spec.ts` перевіряє параметри, незавершену фазу, обидва дедлайни, прогрес A, зміну воркера, скидання лічильників, завелику відповідь і збій збору метрик | Від 1 до 30 прогонів, успішні 30/30 в обох фазах, окремий лічильник прогресу A за час вимірювання B. Гістограми порівнюються для того самого процесу кожного воркера. Очищення за ID тестового тенанта має дедлайн. p95 лише за успішними виконаннями приховував би втрати |
| Міграція давала BYPASSRLS наявній `flowforge_system`, не перевіривши, хто нею діє. Сторонній член групи процесу, адміністратор групи чи вкладена група читали б будь-якого тенанта. На PG<16 міграція не зупинялась | `migration-data.int-spec.ts`: член `flowforge_system`, адміністратор API-групи, група у worker-групі, view з власником `flowforge_system` → міграція відмовляє й нічого не змінює. `provision.int-spec.ts`, `db-security-check.int-spec.ts`: ті самі члени зупиняють provisioning і старт. `tenant-isolation-migration.spec.ts`: PG 15 → відмова до будь-якої ролі | Інваріанти членства перевіряються в міграції, `db:provision` і на старті. Маркер-коментар ролі підробний, а відмова за наявністю ролі ламає спільний кластер |
| Власник БД зі startup-опцією `role=flowforge_api` проходив стартову перевірку як runtime-роль | `db-security-check.int-spec.ts` підключається власником з `options=-c role=…` | Порівняння `current_user` із `session_user` і роллю автентифікації backend-а. Перевірка атрибутів обох ролей окремо складніша, а розбіжна сесія для runtime-процесу не буває легітимною |
| `db:provision` змінював пароль чужого логіна без членств і давав йому права застосунку | `provision.int-spec.ts`: наявний логін без членства → відмова, verifier пароля й членства без змін | Свій логін — лише член своєї групи. Ніколи не змінювати наявний логін — зламало б ротацію пароля |
| Тік планувальника давав тенанту 16 workflow з усіма їхніми спрацюваннями: 16 секундних розкладів A — 192 постановки перед першою B, вимкнений розклад спрацьовував до кінця тіку | `scheduled-fairness.int-spec.ts` з успішними постановками: B не пізніше 16-ї спроби, кожне (workflow, момент) рівно один раз і за зростанням через дві сторінки; розклад, вимкнений посеред тіку, спиняється на межі раунду (16 спроб) | Бюджет 16 спроб на тенанта за раунд із курсором (workflow, останній момент). Ітератори в пам'яті чи глобальне впорядкування — пам'ять без межі |
| Очищення backlog навантажувального сценарію падало на FK `step_runs`, якщо задача A чекала на повтор: відкочувалась уся пачка, backlog лишався | `load-fairness-cleanup.int-spec.ts`: задачі A з кроками в черзі на повтор, сусідній тенант | Кроки видаляються в тому самому операторі (FK `NO ACTION` перевіряється наприкінці оператора). `ON DELETE CASCADE` змінив би продуктову схему заради скрипта |
| Читання глибини черги ставило `statement_timeout` 2 с навіть за `DB_STATEMENT_TIMEOUT_MS=100`, тож клієнтський `query_timeout` спрацьовував раніше за сервер | `queue-depth-timeout.int-spec.ts`: заглушка функції спить довше за межу за 100 мс, типового таймауту й сесії без таймауту → 57014 вчасно | Менше з 2 с і `statement_timeout` сесії на боці БД (враховує будь-яке джерело таймауту). Інжект конфігурації знав би лише env |
| Одне невдале читання глибини черги рахувалося кожним одночасним скрейпом | `queue-depth-metrics.spec.ts`: два одночасні скрейпи, одне читання → +1; два послідовні → +2 | Лічильник — у спільній операції читання. Кешування невдачі приховувало б відновлення |
| Команди «Міграції БД» і тестова адреса БД у README брали паролі з оточення оболонки: у новому терміналі — порожній пароль | `readme-commands.spec.ts` виконує блоки README в чистому оточенні з маркерами в кореневому `.env` | Читання через `parseEnv`, як у локальному запуску; `source .env` виконав би файл як скрипт |
| Тригер обліку шукав новий `nextRunAt` через `min()`. Коли статистика не бачила свіжого backlog-у тенанта, план агрегував усю його чергу: одне захоплення з черги в 20 000 задач читало 20 001 рядок | `tenant-usage-next-run.int-spec.ts`: статистика лише іншого тенанта, autovacuum вимкнено, 20 000 задач, нове з'єднання, одне `claim_job` → кількість прочитаних рядків `jobs` і правильний `nextRunAt` | `ORDER BY "runAt" LIMIT 1` в обох версіях функції. `plan_cache_mode = force_custom_plan` не допоміг би: хибна оцінка походить зі статистики, а не з generic-плану |
| Воркер кидав задачу з чинним lease, і reaper повторював її HTTP-крок: наступне продовження стартувало через третину lease після відповіді попереднього, а дедлайн рахувався від його старту. Відколи продовження — транзакція з контекстом тенанта, на повільнішому CI дві відповіді поспіль перевищували запас (`connection-pool.int-spec.ts`: 67 викликів замість 64) | `lease-keeper.spec.ts`: кожне продовження триває чверть lease → задачу не кинуто. Стрес-прогін `connection-pool` з удвічі повільнішим оновленням задач: до виправлення 2 падіння з 4, після — 5 з 5 зелені | Розклад від старту останнього успішного продовження, як уже було для першого. Довший lease чи менший запас лише відсунули б поріг |
| Webhook невідомому чи вимкненому workflow отримував 404 ще до перевірки підпису й не рахувався жодним лімітом: перебір випадкових UUID без автентифікації й без меж навантажував БД пошуком тенанта | `rate-limit-ip.int-spec.ts`: три webhook-и випадковим UUID → 404 з `X-RateLimit-Remaining`, четвертий → 429 | Такий запит рахується лімітом невдалих автентифікацій за IP, як невірний ключ чи підпис. Окремий ліміт для 404 дублював би той самий захист від перебору |
| Міграція перевіряла власність `flowforge_system` лише в цій БД, а BYPASSRLS надавала на весь кластер: definer-функція цієї ролі, заздалегідь створена в сусідній БД, після міграції читала рядки поза політикою | `system-role-bypass.int-spec.ts`: сусідня БД із RLS-таблицею (`USING (false)`) і definer-функцією `flowforge_system`; перевірка в транзакції, де роль ще без BYPASSRLS | Поки роль без BYPASSRLS — жодних її об'єктів у кластері (з назвами БД у помилці); з BYPASSRLS надання нічого не змінює. Окрема роль на БД змінила б сталі імена в усіх перевірках і матриці прав |
| Перевірка на старті й `db:provision` не бачили зайвого `EXECUTE`: API-група з грантом на `claim_job` чи `PUBLIC` з `purge_execution_history` проходили, і API забирав би задачі або видаляв історію всіх тенантів | `db-security-check.int-spec.ts`: гранти групі, `PUBLIC`, тригерній функції і definer-функції в іншій схемі; `provision.int-spec.ts`: provisioning відмовляє без жодної зміни | Ефективні права (`has_function_privilege`, враховує `PUBLIC`) проти переліку функцій кожної групи; поза `public` — жодної доступної definer-функції. Перевірка лише прямих ACL пропустила б `PUBLIC` |
| Інтеграційні тести лишали на кластері логіни `flowforge_*_test` з паролями з репозиторію: на спільному кластері ними можна було підключитися до інших БД із типовим `CONNECT` для `PUBLIC` | Після прогону `pg_roles` не містить тестових логінів; паролі тестів provisioning — випадкові | Випадкові паролі на прогін (global setup → оточення тестових процесів) і видалення ролей у global teardown. Тимчасовий кластер на прогін потребував би Testcontainers, який план не погоджує |
| Захоплення просувало одну пачку (32) дозрілих тенантів: B за 64 дозрілими тенантами з задачами в роботі чекав три захоплення, а A без задач у роботі обслуговувався двічі — гарантію 3.3.5 порушено навіть без паралельних захоплень. Пропущена SKIP LOCKED єдина готова задача давала «черга порожня» і повну паузу опитування | `fair-claim.int-spec.ts`: 64 дозрілі тенанти перед B (до виправлення — A двічі), понад бюджет промоції (busy, потім B), заблокований рядок задачі (до — `null`) | Міграція `FairPromotion`: промоція до кінця з бюджетом на оператор і busy, якщо його вичерпано; прапорець пропущеної задачі. Промоція без меж ризикувала б `statement_timeout` і відкатом без прогресу; більша пачка лише збільшила б потрібну кількість тенантів |
| Команда README створювала `.env` із секретами з правами 0644 (за типового `umask 022`): інші локальні користувачі читали б, зокрема, пароль суперкористувача Postgres | `readme-commands.spec.ts` виконує команду README і її копію з `.env.example` з `umask 022` — для нового файлу й наявного з 0644 | `touch .env && chmod 600 .env` до запису секретів (так само в CI). Лише `umask 077` не виправив би наявний файл |
| README вимагав «Node.js 20», а команди й CLI міграцій викликають `util.parseEnv`, якого в 20.0–20.11 немає: запуск зупинявся на читанні `.env` | `readme-commands.spec.ts` звіряє діапазон у README з `engines` пакета API | `engines.node` `^20.12.0 \|\| >=21.7.0` і той самий діапазон у README: `util.parseEnv` з'явився в 21.7 і перенесений у 20.12, тож простий мінімум `>=20.12.0` пропускав 21.0–21.6. Власний розбір dotenv дублював би вбудований |
| Стан каталогу, створений не FlowForge, лишав ізоляцію відкритою після успішної міграції: наявна `flowforge_system` з LOGIN і відкритою сесією отримувала BYPASSRLS; `ALTER DEFAULT PRIVILEGES` творця функцій лишав сторонній ролі `EXECUTE` на `purge_execution_history` після `REVOKE … FROM PUBLIC`; чужа дозвільна політика об'єднувалась із `tenant_isolation` через `OR` | `security-posture.int-spec.ts`: окрема БД на кожен варіант класу — default privileges на функції й таблиці, політика `USING (true)`, грант на стовпець, `EXECUTE` для `PUBLIC`, `CREATE` у `public`, чужа функція з `EXECUTE` для групи воркера, view системної ролі поза `public`, службова роль із LOGIN; одночасні запуски. `db-security-check.int-spec.ts`: той самий дрейф і сесія під службовою роллю зупиняють старт | Клас закрито одним механізмом — інваріантами безпеки (3.3.4): `db:migrate` звіряє каталог перед COMMIT і відкочує все, старт процесів відмовляє. Наявна службова роль із чужими атрибутами чи сесіями відхиляється, а не «лагодиться». Точкові перевірки під кожен сценарій (попередній підхід) щоразу лишали наступний варіант того самого класу |
| Захоплення бачило «черга порожня», коли дозрілого тенанта промоція пропустила через `SKIP LOCKED` (його рядок обліку тримала коротка транзакція): воркер чекав повний інтервал опитування | `fair-claim.int-spec.ts`: інша транзакція тримає рядок обліку дозрілого не просунутого тенанта → захоплення повертає busy, після звільнення — задачу | Міграція `ClaimBusyReport`: такі тенанти враховуються в ознаці busy. Чекати на рядок (без `SKIP LOCKED`) серіалізувало б паралельні захоплення |
| Рівно `PROMOTE_BUDGET` (1024) дозрілих тенантів: останній раунд промоції просував останніх кандидатів, але захоплення безумовно повертало busy — зайвий цикл | `fair-claim.int-spec.ts`: рівно 1024 дозрілі тенанти → перше захоплення одразу обирає задачу | Та сама міграція: на останньому раунді busy лише якщо дозрілі ще лишились. Більший бюджет лише зсунув би межу |
| `rate_limit_hit` брав момент до очікування блокування рядка відра: запит, що чекав довше за залишок вікна, рахувався в старому вікні — 429 з додатним `Retry-After`, хоча нове вікно вже почалося | `rate-limit.int-spec.ts`: інша транзакція тримає рядок відра довше за вікно → після звільнення лічильник 1 і нове вікно | Міграція `RateLimitLockTime`: момент береться у виразах `ON CONFLICT DO UPDATE`, які Postgres обчислює вже під блокуванням (і після очікування конкурентної вставки). `SELECT … FOR UPDATE` перед upsert не покривав би гонку вставок; advisory-лок на ключ — ще один лок і колізії хешів |
| Сталі кластерні імена тестів (login-ролі `flowforge_*_test`, допоміжні ролі, тимчасові БД): два прогони з різними `TEST_DATABASE_URL` на одному кластері змінювали паролі й видаляли ролі одне одного | `test-env.spec.ts`: різні тестові БД → різні імена; та сама БД → ті самі (teardown знаходить залишки) | `clusterScopedName` з суфіксом від імені тестової БД для всіх кластерних імен тестів. Випадковий суфікс на прогін не дав би прибрати залишки прогону, що впав |

### Додаткові регресії PR2

Відтворення в `apps/api` через `npm test -- --runInBand` та `npm run test:integration`. Інтеграційні перевірки використовують окрему БД PostgreSQL.

| Дефект і наслідок | Виправлення й перевірка | Розглянута альтернатива |
|---|---|---|
| Після втрати відповіді COMMIT воркер міг переписати успішний крок і повторити оплату | Під fencing-блокуванням воркер звіряє стан кроку. Для збереженого результату звільняє задачу без витрати спроби. У `durable-execution.int-spec.ts` реальний checkpoint завершується в БД, після чого тест відхиляє його Promise. При ліміті в одну спробу workflow завершується, отримувач бачить один виклик | Очікування завершення lease збільшує затримку і може вичерпати останню спробу |
| Завершення SQL-захоплення після початку shutdown запускало нову роботу поза grace period | Воркер перевіряє зупинку одразу після захоплення й повертає задачу. `worker-shutdown.int-spec.ts` затримує повернення результату claim і перевіряє чергу та запити отримувача | Скасування клієнтського запиту залишає результат COMMIT невідомим |
| Стандартний парсер URL-encoded розпаковував тіло до автентифікації | Обидва парсери ділять ліміт і параметр `inflate: false`. `error-responses.int-spec.ts` перевіряє HTTP 415 для стисненої форми | Відключення парсера змінювало б обробку звичайних форм |
| Повільні проходи reaper накладалися й займали пул під час shutdown | Наступний таймер стартує після завершення проходу. Зупинка очікує активні операції обслуговування та перериває цикл між пачками. `worker-maintenance.spec.ts` затримує прохід на кілька інтервалів | Збільшений інтервал лише зменшує ймовірність накладання |
| PATCH з `null` для name, timezone або enabled завершувався помилкою БД | Пропуск валідації лише для відсутнього поля. `workflow-validation.int-spec.ts` перевіряє HTTP 400 й очищення nullable cron | Ігнорування null приховало б помилку клієнта |
| Збережене значення заголовка могло не вміщатися в ByteString Fetch | `definition.spec.ts` перевіряє відхилення непредставного тексту під час валідації workflow | Автоматичне кодування змінювало б значення заголовка для отримувача |
| Відповідь heartbeat після stop знову ставила таймер | `LeaseKeeper` повторно перевіряє стан після очікування БД. `lease-keeper.spec.ts` перевіряє кількість таймерів | `unref()` дозволив би вихід процесу, але зберіг би таймер задачі |
| Jitter збільшував максимальний timeout очищення понад межу Node, що скорочувало паузу до 1 мс | Межа застосовується після jitter. `worker-maintenance.spec.ts` перевіряє затримку при максимально дозволеному інтервалі | Зменшення межі конфігурації порушило б сумісність |
| Перетворення DTO та звичайний об’єкт для headers губили валідні імена | Масив steps доходить до власного валідатора зі всіма ключами. Заголовки зберігаються у словнику без прототипу й передаються Fetch парами. `workflow-validation.int-spec.ts` перевіряє `__proto__` та `constructor` у workflow і версії | Заборона цих імен звужувала б формат HTTP |
| UPSERT кроку й дедуплікація ефекту приховували повторний виклик у тестах | `queue-claim.int-spec.ts` рахує виклики виконавця. Chaos звіряє спроби, час завершення та фактичні HTTP-запити й рядки журналу для відомих завершених кроків. `chaos-checkpoints.spec.ts` подає повтор із правильними загальними числами та перевіряє провал звіту | Заборона всіх повторів помилково відхилила б відновлення незавершеного кроку |
| Затримана відповідь SQL продовжувала локальний бюджет lease і дозволяла розпочати HTTP після його завершення | Бюджет відраховується монотонним годинником до надсилання claim. Перший heartbeat також враховує витрачений час. Перед запуском виконавця воркер звіряє дедлайн. Перевірки у `worker-shutdown.int-spec.ts` та `lease-keeper.spec.ts` | Додаткове підтвердження lease для кожної задачі вимагало б ще одного запиту до БД |
| Вкладена відповідь успішного POST переповнювала стек під час очищення рядків і спричиняла повтор зовнішнього ефекту | Після стандартної JSON-серіалізації один прохід текстом замінює NUL і одиночні сурогати. `unstorable-text.int-spec.ts` перевіряє 2000 рівнів, повний збережений результат і один POST. `storable-text.spec.ts` перевіряє буквальні escape-послідовності й колізію ключів | Обрізання результату за глибиною змінило б вхід наступного кроку |
| Перетворення DTO мовчки відкидало деякі верхньорівневі ключі | До перетворення тіла API звіряє його власні ключі з полями, задекорованими для валідації. POST і PATCH перевірено в `workflow-validation.int-spec.ts`. Правила вкладених JSON-заголовків залишаються окремими | Окремий перелік полів для кожної DTO дублював би її схему |
| SIGKILL після останнього checkpoint або збій транзакції finish міг вичерпати єдину спробу й залишити execution у failed | Під блокуванням job reaper звіряє кожен крок із версією workflow, копіює останній output із БД та фіксує succeeded і done в одній транзакції. `worker-crash.int-spec.ts` вбиває окремий процес після COMMIT кроку. `execution-atomicity.int-spec.ts` перериває сам SQL завершення | Збільшення ліміту спроб залишало б ту саму гонку на останній спробі |
| Старий прострочений lease без токена блокував повернення всієї пачки задач | Reaper завершує задачу під уже взятим блокуванням рядка. У `migration-data.int-spec.ts` задача з готовим результатом отримує `done`, сусідня повертається в чергу | Дозвіл воркеру записувати з порожнім токеном послабив би fencing |
| Чекпоінт старої версії міг підставити результат іншого кроку або пропустити змінений HTTP-запит | Міграція зупиняє неоднозначні виконання, а воркер перевіряє індекс і назву кожного запису перед початком роботи. `migration-data.int-spec.ts` перевіряє перейменований крок, зміну визначення зі збереженим id та збереження чинної спроби, розпочатої після появи знімків | Повний перезапуск міг би повторити вже здійснену операцію |
| Падіння між двома кроками витрачало єдину спробу наступного | Чекпоінт атомарно ставить `jobs.attempts = 0`. Початок наступного кроку під тим самим lease зараховує першу спробу. `durable-execution.int-spec.ts` прострочує lease між кроками при ліміті 1 і перевіряє один HTTP-виклик | Збільшення ліміту лише відсунуло б межу |
| Два HTTP-запити з одним ключем ідемпотентності мали різний порядок ключів у тілі | Контекст продовжує роботу зі значенням `RETURNING output` з PostgreSQL. `durable-execution.int-spec.ts` порівнює байти та ключ обох запитів у отримувача | Порівняння декодованих об’єктів приховало б відмінність для отримувача, який хешує байти |
| Після помилки паркування задача була завершена, а крок паузи залишався у `running` | Воркер утримує поточний крок від початку спроби до фіксації паркування. `durable-execution.int-spec.ts` перериває паркування на останній спробі та читає стан кроку з БД | Наступний прохід reaper опрацьовує лише активні задачі |
| Обрив тіла відповіді 403, 429 чи 503 змінював рішення щодо повтору | Виконавець читає статус і `Retry-After` із заголовків та скасовує читання тіла помилки. `step-errors.spec.ts` моделює помилку потоку для всіх трьох статусів | Повтор кожного обриву ігнорував би остаточний 403 та час, вказаний отримувачем |
| Гістограма тривалості кроків пропускала паузи | Воркер реєструє завершену паузу один раз за різницею `finishedAt − startedAt` із БД. `worker-metrics.int-spec.ts` читає кількість і сумарний час для нульової та відкладеної пауз | Вимірювання лише часу пробудження пропустило б очікування в черзі |

### 39–43. Межі кроків та автентифікація webhook

| Дефект у базі | Доказ до виправлення | Виправлення та перевірка |
|---|---|---|
| Шаблон читав успадковане поле | `template.spec.ts` повернув `Ada[outer]` при очікуванні `Ada[]` | Власні поля, дозволені корені та перевірка обсягу кожного фрагмента у спільному renderer. |
| HTTP передавав непублічну адресу в транспорт | `step-policy.spec.ts` отримав 200 від фікстури замість остаточної відмови | Контрольована адреса сокета, повторна перевірка переходів, ліміт фактичних байтів і скасування. |
| Старий transform виконував JS та довільно великий результат | `transform.spec.ts` повернув число для виклику JS-функції і прийняв рядок понад 64 КіБ | Окремий процес із дозволеним AST та бюджетами. `transform-runtime` перевіряє реальний чекпоінт і наступну задачу. |
| Навіть правильний HMAC точних байтів з пробілами відхилявся | `webhook-input` отримав 401 замість 202 | HMAC префікса v1 та raw Buffer перед JSON-парсингом. |
| Повторна доставка дублювала постановку | Той самий тест на PostgreSQL отримав дві execution і дві job замість однієї кожного типу | Durable receipt та транзакція постановки з унікальним ключем. |

Варіанти рішень та межі описані в 3.3.6–3.3.7. Прогін для перевірки — `npm test -- --runInBand` і `npm run test:integration -- --runInBand` з окремою тестовою БД. Окремо `security-posture` виявив пропуск перевірки типу tenant relation. Міграція з порожнім представленням замість таблиці раніше повертала успіх. Тепер обов’язкова наявність кожної тенантної таблиці серед об’єктів, для яких фактично перевірено RLS.

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

У 3.3.6–3.3.7 тестові відправники в webhook-input, json-depth, rate-limit, role-operations, tenant-queue-limit та unstorable-text підписують точні байти v1. Глибокий підписаний JSON дає 400. Перевірка санітизації помилки кроку тепер підставляє StepError у тестовий виконавець, оскільки довільний JS недоступний. Env-example перевіряє реєстрацію трьох параметрів HTTP у спільній схемі. Step-errors підміняє той самий клієнт undici, що й production; тест забороненого порту використовує hostname для ізоляції перевірки порту. Receiver надає дозвіл лише на свій порт. Тест відмовленого з’єднання надає такий самий дозвіл щойно закритому порту. Chaos overlay фіксує точний origin та IP sink в окремій мережі приймача й воркерів. CI порівнює конфігурацію мережі БД до перемикання оверлею. Її заміна в тестовому розгортанні призводила до таймауту повторного запуску міграцій. Базовий Compose цього дозволу не задає. DB ACL містить SELECT та INSERT для квитанцій лише API-ролі.

Під час виправлення PR №3 `provision.int-spec.ts` перевіряє явну відмову для стороннього членства до зміни пароля. `db-acl.int-spec.ts` включає вузьку функцію пошуку тенантів планувальника. Обидва `background-error-*.spec.ts` підставляють сторінку workflow й операцію постановки cron за новим контрактом, зберігаючи перевірки кореляції та захисту логів. У `query-plans.int-spec.ts` перевірка назви індексу доповнена перевіркою його часової умови. Додані регресійні сценарії та їхні причини наведено в таблиці вище.

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
| `test/integration/queue-claim.int-spec.ts` | для кожного з трьох воркерів фіксуються фактичні виклики StepExecutor та їхні ключі | один рядок кроку після UPSERT може відповідати кільком викликам |
| `test/unit/version-snapshot.spec.ts`, `test/unit/background-error-context.spec.ts`, `test/unit/lease-keeper.spec.ts` | тестові захоплення отримали монотонний час початку claim | він є частиною контракту захопленої задачі та визначає дедлайн |
| `test/integration/worker-crash.int-spec.ts`, `test/integration/execution-atomicity.int-spec.ts` | додано SIGKILL під час фіналізації та ліміт однієї спроби | відрізняє відновлення за checkpoint від випадкового успіху за рахунок додаткової спроби |
| `test/integration/migration-data.int-spec.ts` › JobFinishedAt | тестова задача в черзі має виконання у стані `pending` зі знімком | окремо перевіряє відсутність часу завершення для активної задачі після всіх міграцій. Задачу вже успішного виконання тепер закриває RecoverCheckpoints |
| `test/integration/worker-metrics.int-spec.ts` | додано паузи 0 і 150 мс та перевірки count і sum | виявляє пропущені, подвійні та передчасні спостереження тривалості паузи |
| `test/helpers/global-setup.ts`, `integration-env.ts`, `test-env.ts`, `app.ts`; `worker-crash.int-spec.ts` | застосунок у тестах ходить у БД runtime-ролями (`flowforge_api_test_<суфікс>`, `flowforge_worker_test_<суфікс>`, створює global setup), воркер — своєю роллю через провайдер `RUNTIME_DATABASE_URL`; окремий процес воркера отримує URL ролі воркера | застосунок більше не працює суперкористувачем (проблема 35); тести перевіряють систему з тими самими правами, що й у compose. Підготовка й перевірка даних — як і раніше, з'єднанням власника |
| `test/unit/background-error-*.spec.ts`, `claim-backoff.spec.ts`, `version-snapshot.spec.ts`, `worker-maintenance.spec.ts` | замість заглушок репозиторіїв — `fakeTenantDb` (`test/helpers/fake-tenant-db.ts`), планувальник отримує `SystemDb` зі сторінками workflow | сервіси читають БД лише через `TenantDb`/`SystemDb`; заглушки підставляють ті самі дані, перевірки (лог з кореляційним ID без секретів, неповторюваний провал без знімку, відступ захоплення, обслуговування) не змінені |
| `test/integration/migration-data.int-spec.ts` | тести старих міграцій доганяють схему лише до `TenantIsolation` (`migrateBefore`); тест reaper-а, що проходить усі міграції, створює справжнього тенанта; `afterAll` очищає таблиці до повного застосування міграцій | дані старих форматів у цих тестах — без тенантів і з довільними посиланнями, яких `TenantIsolation` (свідомо) не приймає; їхні власні перевірки ті самі. Поведінку `TenantIsolation` на таких даних перевіряють нові тести там само |
| `test/integration/timestamps.int-spec.ts`, `query-plans.int-spec.ts`, `queue-recovery.int-spec.ts`, `job-retention.int-spec.ts`, `execution-retention.int-spec.ts` | рядки створюються з наявними тенантом і виконанням того самого тенанта; `step_runs` — з `tenantId`; у `job-retention` очікувана кількість виконань — `6 + OLD_BULK` (масові задачі тепер мають свої виконання) | композитні FK і `step_runs.tenantId` (проблема 35) не допускають рядків, що посилаються на неіснуюче або чуже; перевірки (моменти часу, плани запитів, повернення 250 задач, очищення) ті самі |
| `test/integration/query-plans.int-spec.ts` › expired leases | `EXPIRED_LEASES_SQL` отримує параметр тенанта | reaper обробляє прострочені задачі по тенанту, під RLS; індекс той самий |
| `test/integration/retry-after.int-spec.ts`, `execution-atomicity.int-spec.ts` | тестові тригерні функції — `SECURITY DEFINER` | тригер спрацьовує в транзакції воркера, а роль воркера (свідомо) не має прав на службові таблицю й послідовність тесту; що саме імітує тригер, не змінено |
| `test/integration/db-timeouts.int-spec.ts` › CLI | адресу недосяжного сервера задано через `MIGRATION_DATABASE_URL` | CLI міграцій тепер підключається власником схеми з цієї змінної; перевірка таймауту та сама |
| `test/unit/env-example.spec.ts`, `test/unit/admin-token.spec.ts` | `DATABASE_URL` і `ADMIN_TOKEN` у `.env.example` — закоментовані підказки; перевіряється, що решта змінних є, а секретів у спільному файлі немає; підказане `change-me-admin` у production відхиляється | секрети кожен сервіс compose отримує окремо (проблема 36); заявлена поведінка (приклад повний і валідний, приклад-токен не діє в production) та сама |
| `test/integration/json-depth.int-spec.ts` › «answers an unsigned webhook … with 401 and no details» | `not.toMatch(/JSON\|64\|рівн/)` перевіряє лише поле `message`, а не все тіло | тіло містить випадковий `correlationId`, а UUID містить «64» приблизно в кожному десятому прогоні — тест падав незалежно від поведінки; заявлена перевірка (у відповіді немає пояснення формату) та сама |
| `test/integration/queue-claim.int-spec.ts` | цикл захоплення продовжує на `undefined` («кандидатів саме захоплюють інші») і завершується на `null` | `claimNext` розрізняє порожню чергу й зайнятих кандидатів (3.3.5); перевірка (кожну задачу захоплено рівно один раз) та сама |
| `test/helpers/global-setup.ts` → `test/helpers/test-provision.ts`; `migrations`, `migration-data`, `timestamps` | провіжинінг тестової БД винесено в хелпер і повторюється після тестів, що перезастосовують міграції; ліміт одночасних задач за замовчуванням у тестах — 1000 | міграція `TenantUsage` засіває вбудовані значення лімітів заново; наявні тести черги захоплюють десятки задач одного тенанта без завершення, а тести лімітів задають ліміти тенанта явно |
| `test/helpers/integration-env.ts`, `test/helpers/db.ts` | `ADMIN_RATE_LIMIT` і `AUTH_FAILURE_RATE_LIMIT` у тестах — 10000; `truncateAll` очищає й `rate_limit_buckets` | усі тести ходять з 127.0.0.1, тож ліміти за IP інакше переходили б між тестами й файлами; тести цих лімітів (`rate-limit-ip.int-spec.ts`) задають свої значення |
| `test/integration/db-acl.int-spec.ts`, `rls.int-spec.ts` | матриця прав і заборонені операції доповнені новими таблицями й функціями (`tenant_usage`, `limit_defaults`, `rate_limit_buckets`, `claim_job`, `lock_tenant_usage`, `tenant_limits`, `rate_limit_hit`, …); `claim_fifo_candidate` прибрано | захоплення FIFO замінено (проблема 37), нові об'єкти — частина матриці «Операції → права»; принцип перевірки (точна відповідність) той самий |
| `test/integration/query-plans.int-spec.ts` › захоплення | план запиту задачі тенанта береться з тіла `claim_job` у каталозі й очікує `IDX_jobs_tenant_queue`; додано план вибору тенанта на 2000 тенантах | захоплення тепер — за тенантом (проблема 37); перевірка (потрібний індекс, без `Seq Scan`) та сама |
| `test/integration/tenant-predicates.int-spec.ts` | `ExecutionsService` отримує `LimitsMetrics` | нова залежність (метрика відхилених постановок); перевірки ті самі |
| `test/integration/role-operations.int-spec.ts` | очікування захоплення — `Boolean(claimed)` | `claimNext` може повернути `undefined` (зайняті кандидати); перевірка та сама |
| `test/helpers/test-env.ts`, `global-setup.ts`, `test-provision.ts`, новий `global-teardown.ts`; `provision.int-spec.ts` | паролі тестових ролей — випадкові на прогін, ролі видаляються після прогону | на спільному кластері не лишається логінів із паролем із репозиторію; перевірки ті самі |
| `execution-retry`, `retry-after`, `connection-pool`, `worker-crash`, `execution-atomicity`, `execution-errors` (`*.int-spec.ts`) | тестові тригерні функції створюються з `REVOKE ALL … FROM PUBLIC` | перевірка на старті тепер відхиляє будь-яке зайве `EXECUTE` групи процесу (зокрема через `PUBLIC`); тригер викликає функцію без права `EXECUTE`, тож поведінка тестів та сама |
| `test/integration/query-plans.int-spec.ts` › промоція | план береться з вибору пачки (`SELECT … FROM tenant_usage m … SKIP LOCKED`), а не з `UPDATE … SET ready` | промоція тепер — вибір пачки й оновлення за її id (міграція `FairPromotion`); перевірка (`IDX_tenant_usage_maturing` з часовою межею в `Index Cond`, без `Seq Scan`, мало сторінок) та сама |

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
  Локальний строк дії та перше продовження відраховуються від моменту надсилання SQL захоплення за монотонним годинником.
  Кожне наступне продовження призначене на третину lease від старту попереднього успішного, а не
  від його відповіді: запас дедлайну (20% lease) з'їдає затримка одного продовження, а не двох
  поспіль, тож повільна БД (продовження — транзакція з контекстом тенанта) не змушує воркер кинути
  задачу з чинним lease.
  Якщо продовження змінило 0 рядків, lease забрали: `AbortSignal` скасовує поточний крок, і
  воркер більше нічого не пише. Тимчасова помилка БД не скасовує роботу одразу: спроби тривають,
  поки за годинником воркера лишається понад 20% lease.
- **Повернення задач** — один активний reaper на воркер (пауза `lease/2` після завершення проходу, `SKIP LOCKED`, пачками по
  100). Прострочений lease рахується як спроба і повертає задачу з тим самим backoff: «отруйна»
  задача, що раз у раз валить воркер, закінчиться в `dead`, а не крутитиметься вічно.
- **Fencing.** Кожен запис про задачу (чекпоінт, завершення, провал, повернення) — транзакція, що
  починається з `SELECT … FOR UPDATE` рядка задачі з умовою `lockToken = $мій`. Воркер, якого
  вважали мертвим, але який прокинувся, нічого не перезапише.
- **Повтори.** Помилки повторювані: мережа і таймаут, HTTP 408/425/429/5xx, будь-яка не
  класифікована помилка (наприклад, збій БД). Неповторювані: решта 4xx, помилки `transform`. Затримка — full
  jitter у межах `[JOB_BACKOFF_BASE_MS, min(JOB_BACKOFF_MAX_MS, base·2^спроба)]`.
- **Ліміт спроб і `dead`.** `JOB_MAX_ATTEMPTS` (5) на кожен крок: лічильник починається знову
  після кожного чекпоінта. Між кроками він дорівнює нулю. Нове захоплення або початок наступного кроку в тому самому lease зараховує першу спробу. Стани задачі: `queued`,
  `running`, `done`, `failed` (неповторювана помилка), `dead` (повторювані помилки вичерпали
  ліміт або lease минув на останній спробі до фіксації всіх кроків). Виконання в обох останніх випадках — `failed` з
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
паузу до `1,5 × WORKER_POLL_INTERVAL_MS` у порожній черзі. До фактичної затримки захоплення
додаються планування циклу й час запиту до БД (`flowforge_job_claim_latency_seconds`). Reaper
бачить прострочений lease під час наступного проходу. Час відновлення включає роботу БД і backoff. Справедливість між тенантами в запиті захоплення — розділ 3.3.5.

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

Якщо воркер втратив підтвердження COMMIT, він під блокуванням задачі читає стан кроку.
Збережений `succeeded` повертає задачу в чергу для продовження навіть на останній спробі.
Якщо воркер зник після останнього checkpoint, reaper завершує виконання за знімком версії,
використовуючи вихід останнього кроку прямо зі збереженого JSONB.
До фіксації результату `transform` може обчислитися повторно й дати інше значення
(наприклад, вираз із `Date.now()`), а запис `log` може з’явитися двічі. Ефективно-одноразовий ефект `http` гарантується лише для отримувача,
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

### 3.3.4 Ізоляція тенантів у глибину

**Два незалежні шари.** (1) Код: кожен запит сервісу має явний предикат `"tenantId"` (виконання,
кроки, задачі, workflow, версії), а чуже — 404, як неіснуюче. (2) Postgres: RLS з `FORCE` на кожній
тенантній таблиці під ролями без BYPASSRLS. Шари доводяться окремо: `tenant-predicates.int-spec.ts`
запускає сервіси на з'єднанні власника, що обходить RLS (прибраний предикат — червоний тест, хоча
HTTP-тести зелені завдяки RLS, див. проблему 34), а `rls.int-spec.ts` — прямий SQL під runtime-ролями
в обхід сервісів. Третій рубіж — композитні FK: рядок задачі чи кроку може посилатися лише на
виконання свого тенанта, виконання — лише на знімок свого тенанта (FK-перевірки Postgres не залежать
від RLS, тож це тримається навіть для власника схеми).

**Варіанти.** Схема чи окрема БД на тенанта: міграції й пули з'єднань множаться на кількість тенантів,
черга задач (одна таблиця, спільна для воркерів) розпадається. Лише фільтри в коді (стартовий стан):
одна помилка в запиті — витік (проблема 34). Окрема роль Postgres на кожного тенанта (`SET ROLE`):
ролі множаться, а застосунок, що перемикає роль, однаково може перемкнутися на будь-яку. Обрано RLS з
однією політикою за контекстом `app.tenant_id` (підхід документації Postgres, «Row Security
Policies») поверх предикатів у коді.

**Ролі.** Міграція створює групові ролі (NOLOGIN, спільні для кластера, `down` їх не видаляє):
`flowforge_api_role` і `flowforge_worker_role` — без BYPASSRLS, з правами лише на потрібні операції;
`flowforge_system` — BYPASSRLS, власник SECURITY DEFINER-функцій. Login-ролі `flowforge_api` і
`flowforge_worker` створює `db:provision` (крок `migrate`) з паролями з `.env`, кожна — член лише своєї
групи. Provisioning видає `CONNECT` на цільову БД й відкликає його у `PUBLIC` саме там. Доступ до інших БД кластера визначають їхні власні ACL. Окремі ролі API і воркера —
найменші привілеї: API не може захоплювати задачі чи чистити історію, воркер — читати тенантів,
workflow чи автентифікувати ключі. Міграції виконує суперкористувач: створення ролі з BYPASSRLS і
backfill під `FORCE ROW LEVEL SECURITY` (під яким звичайний власник таблиці теж не бачить рядків)
вимагають саме його.

**Контекст тенанта.** Варіанти: сесійний `SET` під час видачі з'єднання з пулу (лишається на
з'єднанні після повернення в пул — витік до наступного запиту); interceptor, що відкриває транзакцію
на весь HTTP-запит (неявно, тримає з'єднання впродовж усього обробника); явна транзакція з
транзакційно-локальним значенням. Обрано останнє: `TenantDb.run(tenantId, em => …)` — транзакція,
перший оператор якої `set_config('app.tenant_id', $1, true)` (рівнозначно `SET LOCAL`): значення
скидається на COMMIT/ROLLBACK, тож з'єднання з пулу контексту не несе (`tenant-context-pool.int-spec.ts`:
пул на одне з'єднання, після COMMIT, ROLLBACK, помилки й `statement_timeout`). Політика порівнює
колонку з `app_current_tenant()`: UUID із `current_setting('app.tenant_id', true)` або NULL — без
контексту, з порожнім (скинутим) чи сміттєвим значенням не видно нічого й немає помилки приведення.
Транзакція не може змінити тенанта, а невалідний id відхиляється ще до звернення до БД. Правило:
усередині транзакції немає зовнішнього I/O (кроки виконуються поза транзакціями, PR 2);
`idle_in_transaction_session_timeout` страхує. ESLint (`no-restricted-imports`) забороняє
`@nestjs/typeorm` і `DataSource` поза `src/tenancy` і `src/database`, тож новий код не може обійти
шар випадково (основний захист однаково — fail-closed RLS).

**Крос-тенантні кроки.** Варіанти: BYPASSRLS для ролі воркера (вимикає захист для всього воркера,
включно з виконанням кроків тенантів); виняток у політиці для службової ролі (умова в кожній політиці,
легко помилитися); вузькі SECURITY DEFINER-функції. Обрано функції: вони лише знаходять, де є робота,
і віддають ідентифікатори або кількості, а самі рядки застосунок читає й змінює вже під RLS у
контексті конкретного тенанта. Два свідомі винятки — операції, крос-тенантні за природою, що
змінюють рядки самі й лише з явним предикатом: очищення (`purge_*`) і захоплення (`claim_job`, 3.3.5). Власник — `flowforge_system`; `SET search_path = pg_catalog, public,
pg_temp` (`pg_temp` явно останнім — інакше він шукається першим, документація Postgres «Writing
SECURITY DEFINER Functions Safely»), усі імена в тілі кваліфіковані; `EXECUTE` — лише потрібній ролі,
`PUBLIC` — нічого; аргументи обмежені. Підміну імен тимчасовою таблицею перевіряє `rls.int-spec.ts`.

| Функція | Роль | Що віддає |
|---|---|---|
| `auth_tenant(api_key_hash)` | API | id тенанта за sha256 ключа (без секретів) |
| `webhook_tenant(workflow_id)` | API | тенант увімкненого workflow — адресата webhook-а |
| `scheduled_workflows(after, limit)` | API | ідентифікатори запланованих workflow для сумісності з попередньою версією |
| `scheduled_tenants(after, limit)` | API | тенанти з увімкненими розкладами. Планувальник читає сторінки їхніх workflow під RLS |
| `lock_tenant_usage()` | API | блокує рядок обліку тенанта **з контексту** до кінця транзакції й віддає його лічильники й ліміти (постановка; без контексту — помилка) |
| `tenant_limits()` | API | ефективні ліміти тенанта з контексту (перевизначення або значення за замовчуванням) |
| `rate_limit_hit(key, window_ms, cost)`, `purge_rate_limits(batch)` | API | лічильник фіксованого вікна ліміту частоти (годинник БД) і кількість видалених відер |
| `claim_job(worker, lease_ms)` | воркер | одна захоплена задача (рядок задачі змінює сама функція з явним предикатом тенанта, 3.3.5), або ознаки «кандидати зайняті» й «облік перераховано» |
| `expired_lease_tenants(exclude, limit)` | воркер | тенанти з простроченими lease (reaper обробляє кожного під RLS) |
| `purge_finished_jobs(days, batch)`, `purge_execution_history(days, batch)` | воркер | кількість видалених рядків, що вже підпадають під термін зберігання |
| `queue_depth_by_tenant()` | воркер | `(tenantId, queued, running)` тенантів із незавершеними задачами (метрика) |

Тригерні функції обліку (`tenant_usage_on_job`, `…_on_tenant`, `…_on_defaults`) — теж власності
`flowforge_system` і без `EXECUTE` для будь-кого: їх викликає лише тригер.

**Операції → права** (таблиці; рядки звужує RLS). Перевіряється в обидва боки: `db-acl.int-spec.ts`
звіряє каталог прав із цією таблицею точно (зайве право — такий самий провал, як відсутнє), а
`role-operations.int-spec.ts` виконує кожну операцію справжніми ролями на непорожніх даних.

| Роль | Права | Операції |
|---|---|---|
| `flowforge_api_role` | `webhook_deliveries` S I; `tenants` S I U; `workflows` S I U D; `workflow_versions` S I; `executions` S I U; `step_runs` S; `jobs` S I U | автентифікація, створення тенанта, ліміти тенанта (адмін-API), CRUD workflow, запуск (run/webhook/cron), `/retry` (`FOR UPDATE` потребує U), читання виконань, перевірка підпису webhook-а |
| `flowforge_worker_role` | `workflow_versions` S; `executions` S U; `step_runs` S I U; `jobs` S U | heartbeat, `assertLease` (`FOR UPDATE`), чекпоінти, пауза/пробудження, завершення, провал, повернення в чергу, reaper (захоплення — функцією `claim_job`) |
| `flowforge_system` | S I U D на тенантні таблиці, `tenant_usage`, `limit_defaults`, `rate_limit_buckets` | тіла SECURITY DEFINER-функцій і тригерів обліку |

`tenant_usage` (облік), `limit_defaults` і `rate_limit_buckets` runtime-ролям недоступні зовсім:
підробити лічильники чи ліміти неможливо, змінюють їх лише тригери й функції.

`TRUNCATE` (обходить RLS), `REFERENCES`, `TRIGGER`, DDL, таблиця `migrations` — нікому з runtime-ролей;
`CREATE` у схемі `public` відкликано в `PUBLIC`.

**Перевірка на старті.** API і воркер не стартують, якщо їхня роль — суперкористувач, має BYPASSRLS,
може діяти як роль із такими атрибутами, `flowforge_system` чи власник таблиць; якщо API ходить роллю
воркера чи навпаки; якщо будь-яка доступна ролі таблиця схеми `public` не має RLS + FORCE + політики
(нова таблиця, додана без політики, зупинить старт); якщо група процесу має право `EXECUTE` на
функцію схеми `public` поза своїм рядком таблиці функцій вище (прямий грант групі чи `PUBLIC`, напр.
`claim_job` для API — він забирав би задачі, або тригерна функція обліку) чи на SECURITY DEFINER-функцію
в будь-якій іншій несистемній схемі, до якої має `USAGE`; якщо в оточенні є облікові дані власника
(`MIGRATION_DATABASE_URL`). Окрім цього, процес звіряє весь каталог з інваріантами безпеки (нижче, «Інваріанти безпеки»), тож чужий грант будь-якій ролі чи зайва політика теж зупиняють старт. Вимкнути перевірку не можна (`db-security-check.int-spec.ts`).
Сесія мусить бути автентифікована саме runtime-роллю: `session_user` і роль, з якою увійшов backend
(`pg_stat_activity`), збігаються з `current_user`. Інакше власник із startup-опцією `role=…` пройшов
би перевірку як runtime-роль, а `RESET ROLE` повернув би йому права суперкористувача.

**Хто може діяти службовою роллю.** Ролі спільні для кластера, тож перевіряється не лише роль процесу,
а й чужі члени службових ролей. Член групи процесу сам виставляє будь-який `app.tenant_id`, а член
`flowforge_system` обходить RLS. Тому:

- у `flowforge_system` членів немає взагалі;
- член `flowforge_api_role` чи `flowforge_worker_role` — лише login без атрибутів і ADMIN OPTION, що
  не входить в інші ролі й сам не має членів (такі ролі створює `db:provision`). Права цих логінів в
  інших БД кластера не враховуються: тести й compose законно живуть на одному кластері.

Перевіряють це три точки: `TenantIsolation` перед тим, як дати `flowforge_system` BYPASSRLS (і ще вимагає,
щоб `flowforge_system` не володіла жодним об'єктом цієї БД: заздалегідь створений view чи функція з її
власником читали б усіх тенантів навіть після виходу автора з членства); `db:provision` до будь-якої
зміни; старт API й воркера (пізніший `GRANT` зупиняє процес). Міграція вимагає PostgreSQL 16+: модель
спирається на його правила членств (на PG16 творець ролі з CREATEROLE отримує на неї ADMIN OPTION, і
перевірка це бачить; до PG16 CREATEROLE дозволяв призначити собі будь-яку роль). Варіанти: маркер
`COMMENT ON ROLE` підробив би той самий, хто заздалегідь створив роль; відмова за самим фактом
наявності ролі ламала б повторні прогони міграцій на спільному кластері.

**BYPASSRLS діє на весь кластер.** Це атрибут ролі, а не БД, тож перше надання `flowforge_system`
відкрило б обхід RLS і в інших БД кластера: definer-функція чи view цієї ролі, створені там заздалегідь,
почали б читати рядки поза політикою. Тому, поки роль ще без BYPASSRLS, міграція вимагає, щоб вона не
володіла нічим у жодній БД кластера (і спільними об'єктами), і називає БД, де знайдено об'єкти
(`system-role-bypass.int-spec.ts`: пастка з RLS-таблицею й definer-функцією в сусідній БД). Якщо роль
уже має BYPASSRLS (її налаштувала міграція іншої БД того самого кластера, напр. тестової поруч із
compose), надання нічого в кластері не змінює, а об'єкти тієї БД законні. Альтернатива — окрема
системна роль на кожну БД (`flowforge_system_<db>`): ізоляція повніша, але ім'я ролі перестає бути
сталою, а від неї залежать міграції, матриця прав, перевірки на старті й compose; перевірка першого
надання закриває той самий сценарій без цієї ціни.

**Чий логін змінює `db:provision`.** Наявний логін вважається своїм, лише якщо він уже прямий член своєї
групи: `CREATE ROLE` і `GRANT` виконуються в одній транзакції, тож роль від `db:provision` без членства
не буває. Логін з тим самим ім'ям, що належить комусь іншому, лишається з паролем і без прав застосунку;
помилка радить видалити роль або обрати інше ім'я (`API_DB_USER`, `WORKER_DB_USER`). Якщо членство
зняли вручну, його відновлюють `GRANT flowforge_api_role TO <логін>` (або `flowforge_worker_role`).

**Межа гарантії.** Контекст тенанта ставить сам runtime-процес після автентифікації: API — за ключем
або підписом webhook-а, воркер — за `tenantId` захопленої задачі. RLS захищає від помилок коду (забутий
предикат, неправильний id), а не від скомпрометованого процесу чи SQL-ін'єкції: та сама роль може
задати будь-яке `app.tenant_id`. Від цього захищає параметризація всіх запитів і найменші права ролі
(зокрема, API не може захоплювати задачі, а воркер — читати секрети тенантів). Між тенантами навмисно
віддають дані лише функції з таблиці вище й лише те, що в ній перелічено.


#### Модель загроз і непідтримуваний стан

**Від кого захищаємо.** Тенант (будь-які запити з власним ключем, визначення workflow, вхід
виконань, частота й обсяг запитів); відправник webhook-а (будь-хто в інтернеті); ціль кроку `http`
і endpoint сповіщень (відповідь, редиректи, DNS, розмір, швидкість); користувач фронтенду. Жоден із
них не повинен читати чи змінювати дані іншого тенанта, виконати код хоста, дістатися внутрішньої
мережі, обійти ліміти чи вичерпати ресурси воркерів для інших. Система переживає падіння будь-якого
процесу в будь-якій точці, кілька інстансів, рестарт і недоступність Postgres, повтори й дублікати,
часові пояси й DST.

**Кому довіряємо.** Оператору розгортання: суперкористувачу Postgres, що запускає міграції,
власнику хоста й compose, тому, хто має доступ до `.env`.

**Підтримуване розгортання.** PostgreSQL 16+, Node.js за `engines` з `apps/api/package.json`. Ролі
`flowforge_api_role`, `flowforge_worker_role`, `flowforge_system`, login-ролі `db:provision` і
об'єкти схеми `public` створюють і змінюють лише міграції й `db:provision`. Кластер може бути
спільним з іншими БД FlowForge (тестова поруч із compose).

**Непідтримуваний стан виявляється, а не захищається.** Ролі, гранти, `ALTER DEFAULT PRIVILEGES`,
політики RLS, сесії чи об'єкти, які створив не FlowForge (заздалегідь, паралельно або вручну
всупереч інструкції), система не намагається «обробити безпечно» сценарій за сценарієм. Вона
відмовляється працювати: інваріанти безпеки нижче звіряють фактичний каталог із дозволеним
переліком, міграції відкочуються, а API й воркер не стартують.

#### Інваріанти безпеки

`src/tenancy/security-posture.ts` (`findPostureViolations`) звіряє каталог Postgres із переліком
`POSTURE` — кінцевим станом після всіх міграцій. Перевірка рольово-агностична: одержувачем може
бути будь-яка роль, включно з `PUBLIC` і ролями, про які FlowForge нічого не знає.

| Інваріант | Що звіряється |
|---|---|
| I-1 Службові ролі | Точні атрибути (`NOLOGIN`, без SUPERUSER/CREATEDB/CREATEROLE/REPLICATION, BYPASSRLS лише в `flowforge_system`), жодних налаштувань ролі, **жодної сесії** під службовою роллю в усьому кластері, жодних сторонніх членів; службові ролі не володіють і не мають прав ні на що в цій БД поза таблицями й функціями `public` (view чи definer-функція системної ролі в іншій схемі читали б усіх тенантів) |
| I-2 Точні права | Для кожної функції, таблиці, view і послідовності `public`: власник і повний набір (одержувач, право), крім прав самого власника, точно за переліком. Без грантів із `GRANT OPTION`, без прав на окремі стовпці, без `CREATE` у `public` для будь-кого, крім власника. Невідомий об'єкт допустимий, лише якщо він належить власнику міграцій і нікому нічого не дає |
| I-3 Точні політики | На кожній тенантній таблиці (`tenants`, `workflows`, `workflow_versions`, `executions`, `step_runs`, `jobs`, `tenant_usage`) — RLS + FORCE і рівно одна політика `tenant_isolation` (PERMISSIVE, усі команди, `PUBLIC`, точний вираз). Інші політики будь-де в `public` — порушення: дозвільні політики Postgres об'єднує через `OR`, тож одна чужа відкрила б рядки всім |

**Де перевіряється.** (1) `npm run db:migrate` (`src/database/migrate.ts`, крок `migrate` у compose)
виконує всі невиконані міграції й звірку в **одній транзакції** під `pg_advisory_xact_lock`: якщо
каталог не відповідає переліку, транзакція відкочується й жодне надання (зокрема BYPASSRLS системній
ролі) не набуває чинності. Звірка виконується й без нових міграцій, тож кожен запуск виявляє дрейф;
два одночасні запуски виконуються по черзі. (2) Старт API й воркера (`DatabaseSecurityCheck`): дрейф
після розгортання зупиняє процес. Процеси, що вже працюють, побачать дрейф лише після рестарту: зміну
каталогу між рестартами може зробити тільки довірений оператор. Інтеграційні тести будують схему тим
самим `migrate()`.

**Наявна службова роль не «лагодиться».** `TenantIsolation` відмовляє, якщо наявна службова роль має
інші атрибути (зокрема LOGIN) або сесії, замість `ALTER ROLE … NOLOGIN`: до COMMIT такої зміни роль
ще пускала б нові сесії, і вони отримали б BYPASSRLS. Єдина зміна наявної ролі — BYPASSRLS для
`flowforge_system` (для ролі, що вже має його від іншої БД кластера, вона нічого не змінює).

**Нова таблиця чи функція.** Міграція, що додає об'єкт у `public`, має додати й запис у `POSTURE`
(права, власник, політика). Без нього `db:migrate` відкотиться з повідомленням, що називає об'єкт.
Повідомлення містять лише імена об'єктів і ролей (до 20), без даних тенантів.

**Варіанти.** Окремі перевірки в кожній міграції під кожен сценарій (так було раніше: кожен новий
сценарій «у кластері вже є чужий X» потребував нової латки). Окрема перевірка після `migration:run`
(після COMMIT уже пізно: сесія, відкрита під роллю з LOGIN, отримала б BYPASSRLS). Звірка в
транзакції міграцій і на старті закриває весь клас одним механізмом. Для чужої політики
розглядалась і RESTRICTIVE-політика-страж: вона захищає лише від оператора, що додасть політику між
рестартами, і додає ще одну поверхню, тож обрано точний набір політик.

#### Ліміти тенанта

**Контракт лімітів.** Значення за замовчуванням — `TENANT_*` (записує `db:provision` у
`limit_defaults`), перевизначення окремого тенанта — адмін-API (`limits` у `POST /tenants`,
`GET`/`PATCH /tenants/:id/limits`, `null` — значення за замовчуванням). Межі перевіряються і в API
(400), і `CHECK`-обмеженнями в БД.

| Ліміт (env за замовчуванням) | Межі | Одиниця | Перевизначення | Діє на |
|---|---|---|---|---|
| одночасні задачі (`TENANT_MAX_RUNNING`, 10) | 1..1000 | задач у стані `running` | `maxConcurrentExecutions` | нові **захоплення** |
| розмір черги (`TENANT_MAX_QUEUE_SIZE`, 100 000) | 1..10 000 000 | незавершених задач: `queued` + `running`, включно з паузами `delay` | `maxQueueSize` | нові **постановки**: run, webhook, cron, `/retry` |
| частота API (`TENANT_RATE_LIMIT` / `…_WINDOW_MS`, 600 / 60 с) | 1..1 000 000 / 1..3600 с | запитів тенанта за вікно, усі маршрути разом | `rateLimit` | запити з `x-api-key` |
| частота webhook-ів (`TENANT_WEBHOOK_RATE_LIMIT` / `…_WINDOW_MS`, 600 / 60 с) | ті самі | webhook-ів тенанта за вікно — окрема квота | `webhookRateLimit` | webhook-и з чинним підписом |
| адмін-ендпоінти (`ADMIN_RATE_LIMIT` / `…_WINDOW_MS`, 30 / 60 с) | 1..10 000 / 1..3600 с | запитів з однієї IP-адреси | — | кожен запит `/tenants…`, ще до перевірки токена |
| невдалі автентифікації (`AUTH_FAILURE_RATE_LIMIT` / `…_WINDOW_MS`, 30 / 60 с) | ті самі | невдач з однієї IP-адреси | — | невірний ключ або підпис, webhook невідомому чи вимкненому workflow: понад ліміт — 429 замість 401/404; успішні запити не рахуються |

«Одночасне виконання» — задача в стані `running`: пауза `delay` слоту не тримає (3.3.3), тож
виконання на паузі обмежує ліміт черги, а не ліміт одночасних задач. Зниження ліміту нижче поточного
використання нічого не перериває: задачі в роботі завершуються, черга лишається, а новим захопленням
і постановкам діє новий ліміт. Задачі з простроченим lease рахуються в `running`, доки їх не поверне
reaper.

**Облік.** `tenant_usage` — рядок на тенанта: `queued`, `running`, найраніший `runAt` у черзі
(`nextRunAt`), готовність, момент останнього захоплення, ефективні ліміти. Його веде SECURITY
DEFINER-тригер на `jobs` у тій самій транзакції, що й зміна задачі, тож у кожному закоміченому стані
лічильники **точно** дорівнюють агрегатам `jobs` (`queue-consistency.int-spec.ts` звіряє їх одним
оператором — одним знімком — кожні 25 мс під змішаним навантаженням). Варіанти: `count(*)` на кожну
постановку (O(розміру черги) і гонка без блокування), лічильники в коді сервісів (легко пропустити
шлях — reaper, очищення, повтор), тригер. Ліміти за замовчуванням — у БД, а не в env кожного процесу:
API і воркер не можуть розійтися.

Після захоплення чи вилучення найранішої задачі тригер шукає новий `nextRunAt` як
`ORDER BY "runAt" LIMIT 1` за `IDX_jobs_tenant_queue`, а не `min("runAt")`. Коли статистика ще не
бачить свіжого backlog-у тенанта, планувальник оцінює його чергу в один рядок і для `min()` обирав
агрегат по всіх задачах тенанта: одне захоплення з черги в 20 000 задач читало 20 001 рядок
(`tenant-usage-next-run.int-spec.ts`). `LIMIT` зупиняє обхід на першому живому записі за будь-якої
оцінки. Межа: записи індексу для вже захоплених задач пропускаються, доки Postgres не позначить їх
мертвими, а для цього жодна відкрита транзакція не повинна їх бачити. Довга транзакція в кластері
(аналітика, зависле з'єднання) знову робить пошук пропорційним кількості захоплень за час її життя,
доки її не завершать і не мине vacuum таблиці `jobs`.

**Ліміт черги.** Постановка (`ExecutionsService`) блокує рядок обліку тенанта
(`lock_tenant_usage`) і лише під блокуванням шукає `Idempotency-Key`: повтор уже прийнятого запиту
повертає його виконання (200), навіть коли черга тим часом заповнилась, а десять однакових
паралельних запитів на останнє місце дають один 201 і дев'ять 200 з тим самим виконанням. Повна
черга — 429 `queue_full` ще до будь-якої вставки (нічого не створено). `Retry-After` немає: коли
звільниться місце, залежить від завершення задач і невідомо. `/retry`: виконання `FOR UPDATE` →
облік → задача; при повній черзі — 429, виконання й чекпоінти без змін. Cron при повній черзі
пропускає спрацювання (warn + `flowforge_enqueue_rejected_total{trigger="cron"}`), розклад іде далі.

**Частота запитів.** `@nestjs/throttler` (документація Nest, «Rate Limiting») зі сховищем у Postgres:
власне `ThrottlerStorage`, фіксоване вікно, атомарний upsert функцією `rate_limit_hit` за годинником
БД — один лічильник на всі інстанси API. Guard розширює `ThrottlerGuard`:
- ключ — `<ліміт>:<тенант або IP>` без імені обробника: одна квота на всі маршрути тенанта;
- заголовки `X-RateLimit-Limit`, `X-RateLimit-Remaining` і `X-RateLimit-Reset` без суфікса імені на
  кожній відповіді, що пройшла через ліміт, а на перевищенні — ще й `Retry-After` і тіло
  `rate_limited`;
- guard-и рівня контролера, тож `/health`, `/ready` і `/metrics` не обмежені.

Webhook-и рахуються лише після чинного підпису й на тенанта адресата: підпис перевіряє guard
(`WebhookSignatureGuard`, порівняння за сталий час), а не обробник. Недоступна БД — 5xx, а не
мовчазний пропуск ліміту. Варіанти: лічильник у пам'яті (кожен інстанс рахував би окремо), Redis
(заборонений), пряма таблиця під RLS (runtime-ролі могли б скидати свої лічильники). `UNLOGGED`
для відер відкинуто: таблиця обнулялася б після падіння сервера й не реплікується; `fillfactor 70`
лишає місце для HOT-оновлень лічильників. Відра, чиє вікно скінчилось, API видаляє пачками щохвилини.

**IP клієнта.** Ліміти за IP беруть `req.ip`: без `TRUST_PROXY` — адресу з'єднання (заголовок
`X-Forwarded-For` ігнорується, інакше клієнт сам вибирав би собі IP). За реверс-проксі —
`TRUST_PROXY` з кількістю переходів або адресами проксі (Express `trust proxy`). IPv6 групується за
підмережею /64, як у throttler-а. Фронтенд ходить до API серверним проксі з однієї адреси — ліміти за
IP для його запитів і передача заголовків 429 браузеру заплановані на PR 6.


### 3.3.5 Справедливе планування

**Вимога.** Тенант, що поставив у чергу десятки тисяч задач, не повинен суттєво збільшувати затримку
задач інших тенантів (проблема 37 — FIFO саме це й робив).

**Порядок обслуговування.** Серед тенантів, у яких є готова задача (`nextRunAt ≤ now`) і які не
досягли ліміту одночасних задач, наступним обслуговується той, у кого **найменше задач у роботі**, а
серед рівних — **найдавніше обслужений** (`lastClaimedAt`), далі за `tenantId`; у нього береться
найраніша готова задача. Тенанти, що вже працюють, ділять слоти за max-min, а тенант без задач у
роботі ніколи не чекає за чужою глибиною черги. Новий тенант отримує `lastClaimedAt = момент
створення` і стає в кінець черговості, а не перескакує тих, хто вже чекає.

**Захоплення** — одна SECURITY DEFINER-функція `claim_job`, один оператор; стандартна для черг на
Postgres схема `FOR UPDATE SKIP LOCKED` (документація Postgres, «The Locking Clause»), застосована
двічі:

```mermaid
flowchart TD
  P["промоція до кінця: усі тенанти, чия найраніша задача вже настала → ready (SKIP LOCKED, пачки по 128, до 1024 за оператор)"] --> T
  T["тенант: ready AND running &lt; maxRunning<br/>ORDER BY running, lastClaimedAt, tenantId LIMIT 1<br/>FOR UPDATE SKIP LOCKED — IDX_tenant_usage_claim"] -- знайдено --> J
  T -- "кандидати є, але всі зайняті" --> B["busy → воркер повторює за ~20 мс"]
  J -- "єдину готову задачу тримає коротка транзакція" --> B
  P -- "дозрілих більше за бюджет" --> B
  T -- "кандидатів немає" --> N["null → пауза опитування"]
  J["задача тенанта: queued, runAt ≤ now<br/>ORDER BY runAt LIMIT 1 FOR UPDATE SKIP LOCKED — IDX_jobs_tenant_queue"] -- знайдено --> U
  J -- "немає (облік розійшовся)" --> R["перерахувати облік тенанта, лічильник repairs → наступний тенант"]
  U["UPDATE job → running, lockToken, lockedUntil = clock_timestamp() + lease;<br/>тригер: running + 1, lastClaimedAt = now — під уже взятим блокуванням рядка тенанта"]
```

- **Жорсткий ліміт одночасних задач.** Рядок тенанта блокується в тому самому операторі; Postgres
  перевіряє умову `running < maxRunning` на найновішій версії заблокованого рядка (EvalPlanQual), а
  `running` збільшує тригер під цим блокуванням. Два захоплення одного тенанта не можуть разом
  перевищити ліміт (`tenant-concurrency.int-spec.ts`: 50 паралельних циклів при ліміті 3 → рівно 3).
- **Без черги блокувань.** Рядок, який тримає інша транзакція, пропускається: паралельні цикли
  всіх воркерів розходяться по різних тенантах, а не чекають на рядок одного, і завершення задач
  тенанта не стоять за захопленнями.
- **Готовність без сканування.** Частковий індекс `IDX_tenant_usage_claim` має той самий предикат і
  порядок, що й вибір, тож це Index Scan без Sort, O(log T) — насичені тенанти й тенанти лише з
  майбутніми задачами в нього не потрапляють. «Настала задача» залежить від часу й не може бути
  предикатом індексу: прапорець `ready` ставить тригер (коли задача вже готова) і промоція на
  початку кожного захоплення (коли час минув), за індексом `IDX_tenant_usage_maturing`.
- **Промоція до кінця, перш ніж обирати.** Захоплення просуває всіх тенантів, чия задача настала до
  початку оператора, а вже потім обирає. Перша версія просувала одну пачку (32) за захоплення:
  тенант B за 64 іншими дозрілими тенантами потрапляв до вибору лише на третьому захопленні, і
  швидкий тенант A без задач у роботі тим часом обслуговувався двічі — без жодної конкуренції.
  Тривалість одного оператора обмежена бюджетом (8 пачок по 128): якщо дозрілих більше, захоплення
  нікого не обирає й повертає busy, а промоцію продовжують наступні (паралельні — різні рядки, SKIP
  LOCKED). Так сплеск зі 100 000 тенантів, що дозріли в одну мить, не впирається в `statement_timeout`
  і не відкочується без прогресу, а порядок вибору однаково враховує всіх дозрілих.
- **Зайнята задача — busy.** Якщо SKIP LOCKED пропустив готову задачу тенанта (її рядок тримає коротка
  транзакція), захоплення повертає busy, а не «черга порожня»: воркер повторює за мить, а не через повний
  інтервал опитування. Облік при цьому не перераховується — він правильний.
- **Lease** починається з самого захоплення (`clock_timestamp()`), а локальний відлік воркера — до
  надсилання оператора, тобто не пізніше за БД.

**Гарантія.** Поки тенант B має готову задачу, жодної в роботі й не досяг ліміту, кожен інший тенант
захоплюється не більше одного разу (після захоплення його ключ гірший за ключ B), плюс захоплення,
чий вибір почався раніше (не більше за кількість паралельних циклів C), плюс ті, що відбулися,
поки рядок B тримала його ж коротка транзакція (постановка чи завершення його задачі — мілісекунди).
Тобто від глибини черг інших тенантів затримка B не залежить. `fair-claim.int-spec.ts` перевіряє це за журналом захоплень (4 паралельні цикли, 8 тенантів, ≤ (K−1)+C
захоплень інших за будь-яке очікування), а також: один слот і тенант із 2000 задач — строге чергування;
B за 64 дозрілими тенантами з задачами в роботі — A не більше одного разу раніше за B; дозрілих більше за
бюджет промоції — busy без вибору, далі найкращий за ключем; зайнята єдина задача — busy;
50 тенантів — кожен раз, перш ніж будь-хто двічі; 150 тенантів, що дозріли одночасно (більше за пачку
промоції), — кожен раз; затримка, що настала, поки рядок тенанта зайнятий, — обслуговується першим
же захопленням після звільнення; насичені й лише з майбутніми задачами тенанти не заважають; новий
тенант — у кінці черговості; кілька воркерів — B завершується, поки в A понад 90% backlog-у.

**Варіанти, що розглядались.**
- FIFO (стартовий стан) — проблема 37.
- Найменше в роботі, далі найстаріша задача — на одному слоті тенант із давнішими задачами
  обслуговується весь час.
- Глобальна серіалізація рішень (одне захоплення за раз, advisory lock) — стеля пропускної
  здатності для всіх тенантів.
- WFQ/DRR із вагами — ваг ТЗ не вимагає, а стан дефіциту треба вести для кожного тенанта.
- **Очікування рядка найкращого кандидата** з перевіркою свіжості під блокуванням (перша
  реалізація в цьому PR) — строгіша межа, але паралельні цикли обирали того самого тенанта й
  ставали в чергу на його рядок. Виміряно 160–950 захоплень/с і p95 39–180 мс (FIFO на тій самій
  машині — ~2500/с, 8 мс), а за повільної БД завершення задач тенанта чекали за чергою захоплень,
  доки не минали lease-и. Розподіл кандидатів між циклами (у процесі, потім advisory lock-ами) дав
  лише 880–950/с.
- Обрано стандартний `SKIP LOCKED` на рівні тенантів, а потім задач. Ціна — обхід тенанта лише на
  мілісекунди його власних транзакцій.

**Порядок блокувань.** Правило: у кожній транзакції воркера оновлення `jobs`, яке через тригер
зачіпає рядок обліку тенанта, — останній оператор; захоплення не чекає ніколи.

| Операція | Порядок |
|---|---|
| завершення, провал, пауза, повернення в чергу, чекпоінт, reaper | задача (`FOR UPDATE`) → виконання → облік (тригер) |
| захоплення | облік (SKIP LOCKED) → задача (SKIP LOCKED) — без очікування |
| постановка (run, webhook, cron) | облік (`lock_tenant_usage`) → нові рядки |
| `/retry` | виконання → облік → задача (термінальна — її не тримає ні воркер, ні reaper) |
| очищення | лише термінальні рядки, облік не змінюється |

Ребра «тримає → чекає»: задача → виконання, виконання → облік, облік → термінальна задача (лише
`/retry`). Ребра облік → облік немає, захоплення не чекає — циклу немає. Перевіряє
`queue-consistency.int-spec.ts`: два воркери, постановка через API, повтори, reaper проти воркерів
(lease відбирається посеред кроку), очищення, примусові ROLLBACK і транзакції, що тримають рядки
обліку. Жодного deadlock-у, кожен знімок обліку точно дорівнює агрегатам `jobs`, `running` ніде не
перевищує ліміт.

**Вимірювання** — «Chaos- і навантажувальні сценарії»: бенчмарк захоплення й навантажувальний
сценарій «шумного сусіда».

### 3.3.6 Безпечне виконання кроків

**Вихідний HTTP.** Спільний транспорт перевіряє HTTP(S)-URL, IP-літерал, усі A/AAAA і кожен redirect. IPv4-mapped адреси проходять IPv4-перевірку. Дозволено публічний unicast, із виключеннями для локальних інтерфейсів, службових адрес та операторських CIDR. Якщо внутрішня мережа має публічно маршрутизований префікс, оператор вносить його в `HTTP_DENY_CIDRS`. Кожен перехід отримує окремий dispatcher. Перевірені адреси передаються в lookup сокета, Host/SNI та стандартна перевірка TLS лишаються прив’язаними до імені з URL. Окрема DNS-перевірка перед звичайним fetch допускала б повторне визначення адреси. Egress proxy потребував би окремого сервісу. [Connector undici 6.29.1](https://github.com/nodejs/undici/blob/v6.29.1/lib/core/connect.js)

| Межа | Поведінка |
|---|---|
| Час усієї операції | `HTTP_STEP_TIMEOUT_MS` — 15 000 мс, дозволено 1–60 000. Бюджет спільний для DNS, TLS, усіх переходів і читання. Втрата lease теж скасовує транспорт. |
| Відповідь | `HTTP_RESPONSE_BYTES` — 1 048 576 байтів, дозволено 1–1 048 576. Ліміт фактичного потоку діє без Content-Length. До 16 КіБ заголовків. Запитується identity, інші Content-Encoding відхиляються. Для текстового результату зберігаються перші 10 000 символів прийнятої відповіді. |
| Перенаправлення | До 5 переходів. HTTPS→HTTP відхиляється. На інший origin дозволений GET/HEAD без тіла та користувацьких заголовків. Метод POST на 301/302 і відповідний 303 переходять у GET. Стабільний ключ належить початковому ефекту, `x-request-id` задає платформа. |
| Причина відмови | Політика адрес, розмір та невалідний запит дають остаточну помилку. Мережевий збій, timeout і 408/425/429/5xx допускають повтор. Для 429/503 підтримується Retry-After. Отримувач побічного ефекту має зберігати Idempotency-Key. |

**Шаблони.** URL, HTTP-тіло та повідомлення log читають лише власні властивості `input` і `steps`. При відсутньому полі підстановка порожня. Межі перевіряються під час побудови рядка. URL — до 2 048 символів, тіло — 32 КіБ, лог — 4 096 символів.

**Transform.** Наприклад, `{"id":"shape","type":"transform","expr":"{\"total\": input.quantity * 2}"}` створює версійований крок JSONata. Підтримуються шляхи від `input` і `steps`, літерали, арифметика, порівняння, логіка, умова та конструктори масивів/об’єктів зі сталими ключами. У довільних функцій, шаблонів регулярних виразів і динамічної компіляції немає форми у дозволеному профілі. Перевірка AST відбувається і при записі, і при виконанні. Простий старий шлях `ctx.steps.call.status` читається за власними властивостями зі старою семантикою масивів.

Кожне обчислення працює в окремому процесі Node з порожнім оточенням і V8 old-space 32 МіБ. Повернення кроку після скасування чекає на закриття процесу. Межі — 4 096 символів виразу, 256 вузлів, 32 рівні AST, 4 МіБ контексту, 8 МіБ сумарної верхньої оцінки для посилань на контекст, 64 КіБ серіалізованого результату і 2 048 рівнів JSON. JSONata отримує timeout 250 мс, stack 128 та sequence 4 096. Зовнішній deadline 2 с включає запуск та завершення каналу. Пам’ять heap, розмір JSON і RSS є різними вимірами. Воркер зберігає старий чекпоінт і завершує неприйнятний крок без автоматичного повтору. Межа таймера в event loop самого воркера не забезпечила б його доступності, а worker thread ділить з ним процес. [JSONata guardrails](https://docs.jsonata.org/guardrails) · [JSONata 2.2.2](https://github.com/jsonata-js/jsonata/blob/v2.2.2/jsonata.d.ts) · [Node 20 child processes](https://nodejs.org/download/release/v20.20.2/docs/api/child_process.html)

### 3.3.7 Вхідні webhook-и

Відправник надсилає UTF-8 JSON на `POST /hooks/:workflowId`. Кожен із трьох заголовків трапляється рівно раз.

| Заголовок | Формат |
|---|---|
| X-Webhook-Timestamp | Цілі десяткові секунди Unix без знака й провідних нулів. Час PostgreSQL має відрізнятися не більш як на 300 секунд у будь-який бік включно. |
| X-Webhook-Delivery-Id | 1–128 ASCII літер, цифр, крапок, дефісів або підкреслень. Відправник зберігає цей ID і байти тіла при кожному повторі. |
| X-Signature | `v1=` і 64 малі hex-цифри HMAC-SHA256. Ключ — байти UTF-8 виданого рядка секрету. |

Префікс — ASCII `v1\n<workflowId>\n<timestamp>\n<deliveryId>\n`. Кожне `\n` позначає один байт LF. UUID записується малими літерами. Після останнього LF йдуть точні байти HTTP-тіла. HMAC обох ключових позицій порівнюється через timingSafeEqual. Raw parser маршруту обмежує накопичення до `HTTP_BODY_LIMIT`, стиснення заборонено. Після автентифікації перевіряються окрема квота webhook, UTF-8, JSON і семантичний ліміт входу 64 КіБ. Підписаний нуль байтів дає порожній об’єкт; JSON-літерал `null` відхиляється з 400. [Парсер сирого тіла Express](https://github.com/expressjs/body-parser/blob/1.20.4/lib/types/raw.js)

Вставте `WEBHOOK_SECRET` через сховище секретів або локальне оточення. Задайте `WEBHOOK_URL` як повний URL маршруту. Команди запускаються з `apps/api`. Обидві доставки друкують 202 та той самий UUID.

```bash
npm ci
npm run chaos:sink:build
printf '%s\n' '{ "name": "Ada" }' > event.json
node dist/scripts/send-webhook.js "$WEBHOOK_URL" order-42 event.json
node dist/scripts/send-webhook.js "$WEBHOOK_URL" order-42 event.json
```

Область унікальності — тенант, workflow та delivery ID. Ті самі байти дають попередній executionId, інші байти — 409. Після втрати відповіді повторіть оригінальні байти з тим самим ID. Можна оновити час і підпис. 401 означає помилку автентифікації або часу, 400 — невалідний підписаний вхід, 413 — транспортний ліміт, 415 — непідтримуване кодування чи тип. Невідомий або вимкнений workflow дає 404. Для 429 застосовується чинний контракт rate_limited/queue_full. Відхилення до commit лишає доставку доступною для повтору.

**Транзакційна межа.** Guard встановлює тенанта й ID ключа. Після ліміту частоти обробник відкриває транзакцію з tenant context, блокує тенанта і workflow для читання, рядок обліку для постановки, повторно звіряє активність ключа та час. Далі читає квитанцію, перевіряє квоту нової події і разом фіксує версію, execution, job та квитанцію. Квитанція містить digest тіла й executionId. Первинний індекс `webhook_deliveries_pkey` перевіряється через EXPLAIN у тесті оновлення. Видалення історії виконань зберігає квитанцію, тому GET для історичного executionId може дати 404. Видалення workflow каскадно очищає квитанції. Ціна тривалої дедуплікації — рядок на доставку живого workflow. TTL дозволив би прийняти пізній перепідписаний повтор. Хеш тіла як єдиний ідентифікатор змішав би дві різні події. [Блокування PostgreSQL 16](https://www.postgresql.org/docs/16/explicit-locking.html)

**Ротація без простою.** Запити власника мають `x-api-key`. GET `/tenants/me/webhook-secrets` повертає список ID. POST на той самий маршрут повертає 201 та `{id,secret}` один раз, з Cache-Control no-store. Початковий секрет отримує оператор при POST /tenants. Збережіть нове значення, переведіть відправників і викличте DELETE `/tenants/me/webhook-secrets/:keyId` для попереднього ID. Обидва ключі діють під час переходу. Третій ключ і видалення останнього дають 409, повторне видалення вже відсутнього — 204. Після втрати відповіді POST звірте ID через GET, відкличте невикористаний новий ключ і повторіть ротацію. Старий секрет після відкликання відхиляється також на прогрітих інстансах.

**Оновлення з попередньої версії.** Підготуйте відправників до v1, призупиніть вхідний трафік і збережіть події на стороні відправника. Звірте старі доставки з невизначеним результатом. Завершіть запити та gracefully зупиніть API, планувальник і воркери. Створіть перевірену резервну копію. З нової збірки, з `MIGRATION_DATABASE_URL` власника, запустіть `npm run webhook:preflight`. Звіт друкує ID workflow чи execution, індекс кроку та стан чекпоінту. Перевірте виділені визначення зі старим JS та історію з великими результатами. Опублікуйте потрібні нові версії. Знімок розпочатого виконання лишається старим. Несумісний ще не виконаний вираз дасть остаточну помилку, а новий запуск вимагає звірки попередніх ефектів. Виконайте `db:migrate` і `db:provision` за інструкцією розгортання, перевірте readiness кожного нового процесу і тестову v1-доставку, потім відновіть приймання. Міграція зберігає байти чинного секрету. Не допускайте стару версію API до live-трафіку після перемикання. Після появи квитанцій або другої активної позиції downgrade відмовляє для збереження даних.

### 3.3.8 Планувальник

Тік читає до 500 ідентифікаторів тенантів за сторінку. У раунді кожен тенант робить до 16 спроб постановки зі сторінки до 16 своїх workflow, потім хід переходить до наступного. Рахуються спроби, а не workflow: інакше 16 секундних розкладів одного тенанта за 30-секундний тік давали б 480 постановок поспіль перед першою постановкою сусіда. Після першого раунду обхід продовжується за курсорами тих, у кого лишилися спрацювання. Курсор — лише ідентифікатор workflow і момент останньої спроби, а сторінку перечитують щораунду, тож вимкнений чи змінений розклад враховується вже в наступному раунді. Розглянуті варіанти: одне спрацювання на workflow за раунд з ітераторами в пам'яті (пам'ять росте з кількістю розкладів, а тенант із тисячами workflow однаково домінує) і глобальне впорядкування всіх належних спрацювань за часом (пам'ять без межі). Кожне читання звільняє з’єднання перед постановкою задач. Повтор сторінки чи паралельна постановка того самого моменту спостерігають одне виконання завдяки блокуванню обліку тенанта та унікальному індексу `(tenantId, workflowId, scheduledAt)`. Гарантія діє протягом зберігання запису виконання. Політики пропущених під час простою спрацювань і часові пояси належать до етапу планувальника.

## Модель гарантій виконання

| Рівень | Гарантія | Умови |
|---|---|---|
| Захоплення задачі | у кожен момент задачу тримає не більше одного воркера, і лише він може записати її результат | `SKIP LOCKED` + fencing-токен; «завислий» воркер після втрати lease нічого не запише |
| Крок `http` | **щонайменше один раз**; **effectively-once** для отримувача, що враховує `Idempotency-Key` | повтор можливий, якщо воркер упав або втратив lease після надсилання запиту, але до чекпоінта; усі спроби кроку мають один ключ |
| Крок `transform` / `log` | щонайменше один раз до успішного чекпоінта | до фіксації результату повтор може дати інше значення виразу або ще один запис у журналі |
| Крок `delay` | пауза не коротша за `ms` і не починається заново після перезапуску | `wakeAt` у БД |
| Завершений крок | **не виконується повторно** | чекпоінт записано (транзакція з перевіркою lease) |
| Запуск через API | з `Idempotency-Key` — рівно одне виконання на ключ у тенанті (повтор того самого запиту повертає те саме виконання); без ключа — кожен запит створює нове, тож повтор клієнтом після обриву — щонайменше один раз | ключ зберігається, поки зберігається виконання (`EXECUTION_RETENTION_DAYS`) |
| Повтор виконання (`/retry`) | продовжує з першого незавершеного кроку; завершені кроки не повторюються, повторений `http` має той самий `Idempotency-Key` | лише виконання `failed` свого тенанта; два одночасні повтори — проходить один |
| Виконання | кожен цикл обробки доходить до одного кінцевого стану. Ручний `/retry` після `failed` відкриває новий цикл того самого execution зі збереженим знімком версії | поки є живий воркер; кожен крок має `JOB_MAX_ATTEMPTS` спроб, потім задача `dead`, а виконання `failed` |
| Ліміт одночасних задач тенанта | нова задача тенанта береться в роботу, лише якщо його задач `running` менше за `maxRunning` | перевіряється під блокуванням рядка обліку в момент захоплення. Після зниження ліміту вже взяті задачі доробляються, тож `running` може тимчасово перевищувати новий ліміт; нових захоплень немає, доки `running` не стане меншим (`tenant-concurrency.int-spec.ts`) |
| Ліміт черги тенанта | нова задача тенанта ставиться в чергу, лише якщо його незавершених задач менше за `maxQueueSize`; відхилена постановка (429 `queue_full`) нічого не створює | атомарно з постановкою; повтор того самого запиту з `Idempotency-Key` повертає вже прийняте виконання й без вільного місця; cron пропускає спрацювання. Після зниження ліміту вже прийняті задачі лишаються в черзі й виконуються (`tenant-queue-limit.int-spec.ts`) |
| Ліміт частоти | у вікні не більше за ліміт запитів тенанта (API і webhook-и окремо), за IP — адмін-ендпоінтів і невдалих автентифікацій | один лічильник у Postgres на всі інстанси API; недоступна БД — 5xx, а не пропуск ліміту |
| Справедливість | поки тенант готовий і без задач у роботі, кожен інший обслуговується не більше одного разу (+ захоплення, що вже почались, + обходи на час його власних коротких транзакцій) | 3.3.5, «Гарантія»; від глибини чужих черг затримка не залежить |
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
  E --> C["Захоплення (claim_job): тенант і його задача FOR UPDATE SKIP LOCKED → running, lockToken"]
  C --> L{"Наступний крок без succeeded?"}
  L -- "так, http / transform / log" --> S["TX: lease ✓, step_run running (attempts+1), execution running"]
  S --> X["Виконання кроку поза транзакцією (Idempotency-Key, AbortSignal)"]
  X -- успіх --> K["TX: lease ✓, step_run succeeded + output, job.attempts = 0"]
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
| вибір тенанта для захоплення | `IDX_tenant_usage_claim` — `tenant_usage (running, "lastClaimedAt", "tenantId") WHERE ready AND running < "maxRunning"` (частковий, у порядку ключа вибору) |
| промоція дозрілих тенантів | `IDX_tenant_usage_maturing` — `tenant_usage ("nextRunAt") WHERE NOT ready AND "nextRunAt" IS NOT NULL AND running < "maxRunning"` (частковий) |
| найраніша готова задача тенанта (захоплення, облік) | `IDX_jobs_tenant_queue` — `jobs ("tenantId", "runAt") WHERE status = 'queued'` (частковий; замінив `IDX_jobs_claim`) |
| очищення відер ліміту частоти | `IDX_rate_limit_buckets_reset` — `rate_limit_buckets ("resetAt")` |
| пошук прострочених lease (reaper) | `IDX_jobs_lease` — `jobs ("lockedUntil") WHERE status = 'running'` (частковий) |
| запуск за `Idempotency-Key` тенанта | `UQ_executions_idempotency_key` — унікальний `executions ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL` (частковий) |
| задача виконання (повтор, очищення історії) | `IDX_jobs_execution` — `jobs ("executionId")` |
| завершені виконання, старші за термін історії | `IDX_executions_finished` — `executions ("finishedAt") WHERE status IN ('succeeded', 'failed')` (частковий) |
| завершені задачі, старші за термін зберігання (очищення) | `IDX_jobs_finished` — `jobs ("finishedAt") WHERE status IN ('done', 'failed', 'dead')` (частковий) |
| пошук кроку за ключем ідемпотентності | `UQ_step_runs_idempotency_key` — унікальний `step_runs ("idempotencyKey")` |
| чекпоінти виконання | `UQ_step_runs_execution_step` — унікальний `step_runs ("executionId", "stepIndex")` |
| версія workflow для виконання | `UQ_workflow_versions_workflow_version` — унікальний `("workflowId", "version")` |
| списки виконань за тенантом | `executions ("tenantId", "createdAt")` (зі стартового коду); план перевірено під роллю API в контексті RLS |

Часткові індекси містять лише задачі в черзі чи в роботі, а завершені (яких з часом переважна
більшість) не потрапляють в індекс. На 100 тис. задач (99,8% `done`) кожен із них займає 16 КіБ.
Старий індекс `(status, "runAt")` видалено.

**Як перевірено.** Інтеграційний тест `query-plans.int-spec.ts` засіває 20 тис. задач і кроків
і для того самого SQL, що виконує черга (оператори з тіла `claim_job` у каталозі, `EXPIRED_LEASES_SQL`,
`FINISHED_JOBS_SQL`, `PURGE_FINISHED_SQL`, `PURGE_EXECUTIONS_SQL`, пошук за ключем запуску й
задачі за виконанням), перевіряє в
`EXPLAIN (FORMAT JSON)`, що використовується потрібний індекс і немає `Seq Scan`.

Вибір тенанта перевірено окремо на 2000 тенантах (1000 готових з 0–2 задачами в роботі, 400
насичених з лімітами 1..5, 300 лише з майбутніми задачами, 20 дозрілих, ще не просунутих, решта
порожні): `EXPLAIN (ANALYZE, BUFFERS)` — Index Scan за `IDX_tenant_usage_claim` без Sort, у тесті
межі ≤ 5 мс і ≤ 64 сторінки. Вручну:

```text
-- вибір тенанта (2000 тенантів)
Limit (actual rows=1 loops=1)
  Buffers: shared hit=4
  ->  LockRows (actual rows=1 loops=1)
        ->  Index Scan using "IDX_tenant_usage_claim" on tenant_usage u (actual rows=1 loops=1)
              Filter: (ready AND ("tenantId" <> ALL ('{}'::uuid[])) AND (running < "maxRunning"))
              Buffers: shared hit=3
Execution Time: 0.034 ms
-- усе захоплення (claim_job: промоція 20 тенантів, вибір, задача, тригер обліку)
Function Scan on claim_job (actual rows=1 loops=1)
Execution Time: 2.076 ms
```

Решта — вручну на 100 тис. задач (`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)`):

```text
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

Після переходу на захищений транспорт обидва сценарії пройшли на окремому Compose з PostgreSQL 16 і двома воркерами. На 200 виконань із SIGKILL отримувач побачив 208 запитів та 200 ефектів. На окремі 200 виконань із двома рестартами PostgreSQL отримувач побачив 216 запитів та 200 ефектів. В обох прогонах усі виконання успішні, жодного зміненого завершеного чекпоінту та жодної dead job. Команди нижче.

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
`log → http (sink) → delay 2 с → log` для кожного з двох раундів. У раунді він ставить 100 виконань, вбиває один із воркерів
(`docker kill --signal KILL`, без graceful shutdown) і за 3 с запускає його знову. Після
завершення всіх виконань він перевіряє БД і лічильники отримувача та завершується з ненульовим
кодом, якщо перевірка виявила порушення. Кожна група повинна містити задачу, повернуту після втрати lease або виконану з повторною спробою кроку. Наступна група стартує після завершення попередньої.
Той самий сценарій виконується в CI (job `compose`).

Перед кожним збоєм скрипт читає ідентифікатори вже завершених кроків, кількість спроб та точний час завершення з PostgreSQL. Для HTTP він фіксує кількість запитів у sink за ключем **до дедуплікації**, для log — кількість відповідних рядків у журналах обох воркерів за correlationId. Після відновлення кожне перше спостереження має збігтися з кінцевим. Для delay перевіряється збережений чекпоінт. Ця перевірка допускає повтор кроку, який був незавершеним на момент збою.

Результат (локально, 18.11.2026):

| Показник | Значення |
|---|---|
| Убито воркерів (SIGKILL) | 2 (b784369b503d, 3ae5908871d1) |
| Перерваних задач у кожному раунді | 4 / 4 |
| Виконань поставлено | 200 |
| Час до завершення всіх виконань | 25.6 с |
| Виконань succeeded / failed | 200 / 0 |
| Рядків step_runs (очікується 800) | 800 |
| Кроків, що мали понад 1 спробу (усього / http) | 7 / 7 |
| Чекпоінтів до збоїв (з них HTTP) / змінених після відновлення | 90 (37) / 0 |
| Задач, повернутих reaper-ом (lease минув) | 8 |
| Задач у стані dead | 0 |
| Запитів до отримувача / унікальних ефектів | 207 / 200 |
| Ключів, що прийшли повторно (і не дали другого ефекту) | 7 |

### Перезапуск Postgres під навантаженням (3.3.1–3.3.2)

```bash
# стек з оверлеєм — як вище
(cd apps/api && npm run chaos:postgres)
```

Скрипт `apps/api/scripts/chaos-restart-postgres.ts` ставить те саме навантаження (200 виконань
`log → http (sink) → delay 2 с → log`) і двічі робить `docker compose restart postgres`, чекаючи,
поки БД знову стане healthy. Перевіряє все те саме, що й сценарій із вбивством воркерів, і ще:
жоден процес воркера чи API не перезапустився (`StartedAt` і `RestartCount` контейнерів ті самі),
після відновлення всі вони знову healthy. У кожному раунді перевіряється відновлення перерваної роботи його окремої групи задач. Лічильники помилок захоплення, продовження lease та запису результатів допомагають пояснити наслідки збою. Той самий сценарій виконується в CI.

Результат (локально, 18.11.2026):

| Показник | Значення |
|---|---|
| Перезапусків Postgres | 2 (разом 7.7 с до healthy) |
| Процесів воркерів і API, що перезапустились | 0 з 3 |
| Невдалих захоплень у логах воркерів (з backoff) | 0 |
| Невдалих продовжень lease у логах воркерів | 0 |
| Задач, чий запис обірвався (job processing failed) | 16 |
| Перерваних задач у кожному раунді | 8 / 8 |
| Виконань поставлено | 200 |
| Час до завершення всіх виконань | 24.9 с |
| Виконань succeeded / failed | 200 / 0 |
| Рядків step_runs (очікується 800) | 800 |
| Кроків, що мали понад 1 спробу (усього / http) | 16 / 16 |
| Чекпоінтів до збоїв (з них HTTP) / змінених після відновлення | 88 (36) / 0 |
| Задач, повернутих reaper-ом (lease минув) | 16 |
| Задач у стані dead | 0 |
| Запитів до отримувача / унікальних ефектів | 216 / 200 |
| Ключів, що прийшли повторно (і не дали другого ефекту) | 16 |

### Навантажувальний сценарій справедливого планування (3.3.5)

```bash
# стек з оверлеєм — як вище
(cd apps/api && npm run load:fairness)
```

Скрипт `apps/api/scripts/load-fairness.ts` (стек з `sink`: відповідь через 300 мс, 2 воркери × 4
цикли) у кожному з трьох прогонів створює нових тенантів:

1. «B сам» — 30 виконань тенанта B (`http → sink`) через API, по одному кожні 200 мс.
2. «A сам» — 20 000 виконань тенанта A ставляться в чергу одразу (SQL власником схеми); пропускна
   здатність A за 20 с. Ліміти A (черга 30 000, одночасних 16) вищі за кількість слотів, тож
   справедливість не тримається на лімітах.
3. «B під backlog-ом A» — ті самі 30 виконань B, поки черга A глибока.

Метрики — за годинником БД: очікування B — від створення виконання до початку першого кроку,
повна тривалість — до завершення; p95 захоплення — з гістограми воркерів
`flowforge_job_claim_duration_seconds`. Критерії (кожен прогін; провал будь-якого — ненульовий код
виходу): успішно 30 з 30 виконань B за ≤ 120 с окремо в кожній фазі, а під час другої фази A теж завершує задачі; коли завершилось останнє виконання B, у черзі A
понад 50% backlog-у; p95 очікування B ≤ 3 × p95 «B сам» + 1 с і ≤ 5 с; p95 повної тривалості
≤ 2 × p95 «B сам» + 2 с; p95 захоплення ≤ 100 мс. Той самий сценарій виконується в CI (job `compose`).

Результат на PostgreSQL 16, 19.11.2026. У контрольній фазі кожного прогону також успішно завершилися 30 із 30 виконань B.

| Прогін | B сам: p95 очікування / тривалість | A сам, задач/с | B під A: успішно, фаза | p95 очікування | p95 тривалість | У черзі A наприкінці | p95 захоплення |
|---|---|---|---|---|---|---|---|
| 1 | 0,11 с / 0,43 с | 22,6 | 30/30, 6,31 с | 0,12 с | 0,43 с | 19 393 з 20 000 | ≤ 5 мс |
| 2 | 0,13 с / 0,44 с | 24,6 | 30/30, 6,31 с | 0,20 с | 0,50 с | 19 355 з 20 000 | ≤ 5 мс |
| 3 | 0,15 с / 0,50 с | 23,8 | 30/30, 6,31 с | 0,27 с | 0,58 с | 19 373 з 20 000 | ≤ 5 мс |

Той самий сценарій на попередній версії (e2fadbf, захоплення FIFO; `--baseline`, один прогін, без
критеріїв):

| Версія | B сам: p95 очікування / тривалість | A сам, задач/с | B під A: фаза | p95 очікування | p95 тривалість | У черзі A наприкінці |
|---|---|---|---|---|---|---|
| e2fadbf (FIFO) | 0,22 с / 0,53 с | 23,1 | 800 с | 798,6 с | 798,9 с | 0 з 20 000 |
| ця версія (3 прогони) | 0,11–0,15 с / 0,43–0,50 с | 22,6–24,6 | 6,31 с | 0,12–0,27 с | 0,43–0,58 с | 19 355–19 393 з 20 000 |

На FIFO тенант B чекав, доки воркери виконають увесь backlog A (≈ 13 хв), а тепер його задачі
стартують за десяті частки секунди — майже як без навантаження. Пропускна здатність A, коли він сам,
не змінилась (23–24 задачі/с при 8 слотах і отримувачі з затримкою 300 мс).

### Бенчмарк захоплення

```bash
(cd apps/api && npm run bench:claim)
```

`test/bench/claim.bench-spec.ts` — справжній `JobQueueService` у двох Nest-застосунках з окремими пулами БД і спільним циклом подій одного процесу Node.js, по 16
паралельних циклів (32 разом). Кожен прогін обробляє 20 000 задач на 50 тенантів без виконання кроків.
У режимі `job` цикл захоплює задачу й закриває її за токеном. У режимі `execution` він викликає
`CheckpointService.finish`, як воркер після останнього кроку. Після вимірювання тест перевіряє стан
усіх 20 000 задач, а в режимі `execution` — також стан і результат кожного виконання.
Кожен режим має три прогони справедливої черги та три прогони FIFO на тій самій БД.
Для FIFO відтворено послідовність операцій версії e2fadbf з відповідним обсягом запису.

Критерії відносні, бо абсолютні числа залежать від машини: раннер CI приблизно вдвічі повільніший
за ноутбук (у першому прогоні CI — 824–842 захоплень/с і p95 20–21,5 мс, тоді як локально 1771–1904/с
і ~10 мс). За медіанами прогонів:
- пропускна здатність справедливого захоплення — щонайменше 50% від FIFO;
- p95 — не більше 3 × p95 FIFO;
- у кожному прогоні — не менше 300 захоплень/с (ловить обвал на зразок черги на рядку одного тенанта).

Обидва режими виконує CI (job `integration`). Локальні вимірювання на PostgreSQL 16 після оптимізації завершення у `73867ff`, по три прогони кожної черги:

| Що завершує цикл | Справедливе, медіана задач/с | FIFO, медіана задач/с | Частка FIFO | p95 захоплення, справедливе / FIFO |
|---|---:|---:|---:|---:|
| Задачу (`job`) | 1539 | 2381 | 65% | 12,9 / 8,2 мс |
| Задачу й виконання (`execution`) | 1197 | 1698 | 70% | 15,4 / 9,8 мс |

Попередні локальні вимірювання під час розробки:

| Версія | Захоплень/с (3 прогони) | p50 | p95 | p99 | «Кандидати зайняті» |
|---|---|---|---|---|---|
| справедливе, `SKIP LOCKED` за тенантом до оптимізації завершення | 1771 / 1891 / 1904 | 5,3–5,5 мс | 9,6–11 мс | 14–17 мс | 0,4–0,9% |
| e2fadbf (FIFO), окремий запуск на тій ревізії | 2444 / 2605 / 2634 | 4,1–4,3 мс | 7,5–8,5 мс | 11–14 мс | — |
| той самий запуск бенчмарку: справедливе / FIFO | 1607–1731 / 2551–2672 (61%) | 5,2–6,4 / 3,9–4 мс | 10,6–13,2 / 7,8–8,5 мс (×1,66) | 16–32 / 13–17 мс | 1,0–2,3% / — |
| перша реалізація цього PR (очікування рядка кандидата) | 156–311 | 52–70 мс | 159–196 мс | 197–242 мс | 77–90% застарілих спроб |

Справедливе захоплення додатково перевіряє готовність тенантів і веде облік тригером. Ціна цих операцій залежить від навантаження та обладнання. Перша реалізація, що чекала на рядок найкращого кандидата, виконувала гарантію строгіше, але
паралельні цикли ставали в чергу на рядок одного тенанта — звідси перехід на `SKIP LOCKED` (3.3.5).

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
- **Опитування черги замість `LISTEN/NOTIFY`** — свідоме рішення: затримка захоплення в порожній
  черзі до `1,5 × WORKER_POLL_INTERVAL_MS` через jitter (видно в `flowforge_job_claim_latency_seconds`) проти окремого
  постійного з'єднання на воркер, перепідключення й `NOTIFY` на кожну зміну черги.
- **Оновлення «на ходу»** — міграції виконуються до старту нових воркерів; одночасна робота старих
  воркерів із новою схемою не підтримується (див. «Міграції БД»).
- **Cron при повній черзі тенанта** пропускає спрацювання (warn + метрика). Чи наздоганяти
  пропущені спрацювання, вирішує політика пропущених запусків — частина переробки планувальника
  (3.3.8).
- **Заголовки лімітів через фронтенд** — серверний проксі Next.js ходить до API з однієї адреси й не
  передає браузеру `Retry-After` і `X-RateLimit-*`; ліміти в OpenAPI — разом з OpenAPI-документацією.
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
| `body-parser` 1.20.4 | `@nestjs/platform-express` (жорстко `1.20.4`) | GHSA-27r3-jxmh-p828: падіння процесу від байтів після стисненого тіла (виправлено в 1.20.9) | парсер працює на публічному порту до автентифікації. Відтворити на Node 20.19 не вдалося: сценарій з тесту виправлення upstream (deflate-кадр + байти після завершення декодера, keep-alive) і варіанти з gzip/deflate проти запущеного API — відповідь 200/400, процес живий | версію не змінено (виправлення лише через `overrides` або Nest 11+); застосовано обхід з advisory — `inflate: false`: стиснені JSON і URL-encoded форми відхиляються з 415 до розпакування (проблема 30) |
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
