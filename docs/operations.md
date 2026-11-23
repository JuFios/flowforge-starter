# FlowForge: експлуатація

Детальний довідник оператора: запуск, конфігурація, міграції, тести, спостережуваність, сповіщення, chaos- і навантажувальні сценарії. Короткий огляд — у [README](../README.md).

## Запуск

```bash
cp .env.example .env
docker compose up --build
```

Для локальної розробки цього досить. `.env.example` містить заглушки секретів, які дозволені лише поза `NODE_ENV=production`, а compose відкриває порти тільки на `127.0.0.1` (`PUBLISH_ADDRESS`). Під час старту з заглушками процеси пишуть у журнал попередження.

**Production.** У `.env` (права `chmod 600 .env`) задайте:

- `NODE_ENV=production` — з будь-якою заглушкою `migrate`, API й воркери не стартують;
- `ADMIN_TOKEN`, `POSTGRES_PASSWORD`, `API_DB_PASSWORD`, `WORKER_DB_PASSWORD` — випадкові значення, напр. `openssl rand -hex 24` (паролі БД — лише літери й цифри, щонайменше 24);
- `PUBLISH_ADDRESS` — адреса, на якій compose відкриває API та інтерфейс за TLS-проксі, `PUBLIC_ORIGIN=https://<домен>` і `COOKIE_SECURE=true`.

`POSTGRES_PASSWORD` діє лише під час створення порожнього тому `pgdata`: змінити його пізніше можна лише в самій БД ([docs/operations.md](#оновлення-з-попередньої-версії), «Оновлення з попередньої версії»).

Секрети — лише з `.env` у корені (або зі змінних оточення); без будь-якого з них compose завершується з підказкою. Кожен сервіс отримує тільки свої:

| Секрет | Хто отримує | Навіщо |
|---|---|---|
| `POSTGRES_PASSWORD` | `postgres`, `migrate` | власник схеми — суперкористувач `flowforge`: міграції й створення ролей |
| `API_DB_PASSWORD` | `migrate`, `api` | роль `flowforge_api` (без BYPASSRLS), якою API ходить у БД |
| `WORKER_DB_PASSWORD` | `migrate`, `worker` | роль `flowforge_worker` (без BYPASSRLS), якою ходить воркер |
| `ADMIN_TOKEN` | лише `api` | службові ендпоінти `/tenants…` |

Compose бере `NODE_ENV` з `.env` (типово `development`). У `NODE_ENV=production` заглушка будь-якого секрету
зупиняє `migrate`, API й воркери помилкою валідації (див. «Конфігурація»). Паролі ролей — лише латинські
літери й цифри (щонайменше 24), бо потрапляють у URL підключення; `openssl rand -hex 24` підходить.
CI перевіряє розподіл секретів за сервісами через `docker inspect` (job `compose`).

Порядок старту: `postgres` (healthy) → `migrate` (застосовує міграції власником схеми, потім
`db:provision` створює або оновлює runtime-ролі `flowforge_api` і `flowforge_worker`, і
завершується з кодом 0) → `api` і два `worker` (healthy за `/ready`; кожен перед стартом перевіряє,
що його роль не обходить RLS, див. 3.3.4) → `frontend` (healthy, коли відповідає сторінка).
`docker compose up -d --wait` повертає керування, коли всі сервіси healthy (або з помилкою). Схема БД будується лише міграціями,
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
уже запущено, звільніть порти командою `docker compose stop api api-2 worker frontend` у локальному проєкті.

```bash
# з кореня репозиторію
env -i HOME="$HOME" PATH="$PATH" bash -eu <<'LOCAL_API'
docker compose up -d postgres
cd apps/api
test -f .env || (umask 077; cp .env.example .env)
npm ci
npm run build
setting() {
  node -e 'const {parseEnv}=require("node:util"), {readFileSync}=require("node:fs");
    process.stdout.write(parseEnv(readFileSync("../../.env","utf8"))[process.argv[1]] ?? "")' "$1"
}
pg_port="$(setting POSTGRES_PORT)"
# міграції й ролі — власником схеми (лише цим командам, не API й воркеру)
MIGRATION_DATABASE_URL="postgres://flowforge:$(setting POSTGRES_PASSWORD)@localhost:${pg_port:-5432}/flowforge" \
  npm run db:migrate
MIGRATION_DATABASE_URL="postgres://flowforge:$(setting POSTGRES_PASSWORD)@localhost:${pg_port:-5432}/flowforge" \
  API_DB_PASSWORD="$(setting API_DB_PASSWORD)" WORKER_DB_PASSWORD="$(setting WORKER_DB_PASSWORD)" \
  TENANT_MAX_RUNNING="$(setting TENANT_MAX_RUNNING)" TENANT_MAX_QUEUE_SIZE="$(setting TENANT_MAX_QUEUE_SIZE)" \
  TENANT_MAX_WORKFLOWS="$(setting TENANT_MAX_WORKFLOWS)" TENANT_MAX_OUTBOX_EVENTS="$(setting TENANT_MAX_OUTBOX_EVENTS)" \
  TENANT_RATE_LIMIT="$(setting TENANT_RATE_LIMIT)" TENANT_RATE_WINDOW_MS="$(setting TENANT_RATE_WINDOW_MS)" \
  TENANT_WEBHOOK_RATE_LIMIT="$(setting TENANT_WEBHOOK_RATE_LIMIT)" TENANT_WEBHOOK_RATE_WINDOW_MS="$(setting TENANT_WEBHOOK_RATE_WINDOW_MS)" \
  npm run db:provision
# API на :3000 — своєю роллю
DATABASE_URL="postgres://flowforge_api:$(setting API_DB_PASSWORD)@localhost:${pg_port:-5432}/flowforge" \
  ADMIN_TOKEN="$(setting ADMIN_TOKEN)" npm run start
LOCAL_API
```

Метрики API — `curl localhost:3200/metrics` (службовий порт `METRICS_PORT`).
Воркер — в іншому терміналі, з `apps/api`, своєю роллю (службовий HTTP на `:3100`):

```bash
env -i HOME="$HOME" PATH="$PATH" bash -eu <<'LOCAL_WORKER'
worker_password="$(node -p 'require("node:util").parseEnv(require("node:fs").readFileSync("../../.env","utf8")).WORKER_DB_PASSWORD')"
pg_port="$(node -p 'require("node:util").parseEnv(require("node:fs").readFileSync("../../.env","utf8")).POSTGRES_PORT || "5432"')"
DATABASE_URL="postgres://flowforge_worker:$worker_password@localhost:$pg_port/flowforge" \
  npm run start:worker
LOCAL_WORKER
```

Застосунок і CLI міграцій читають `apps/api/.env` (якщо файл є); змінні, задані в оточенні
(як у docker-compose), мають пріоритет над файлом. Облікові дані власника (`MIGRATION_DATABASE_URL`)
у `apps/api/.env` не кладіть: API й воркер з ними не стартують (див. 3.3.4).

### Оновлення з попередньої версії

Том `pgdata`, створений попередньою версією (до ізоляції тенантів), оновлюється так (з кореня
репозиторію, `.env` з чотирма секретами — як у «Запуск»). Перед оновленням звірте власні значення
спільних пулів API з правилом «Спільні пули API» (розділ «Конфігурація»): процеси не стартують, якщо
`REALTIME_MAX_CONNECTIONS` менше за 2 × `REALTIME_MAX_CONNECTIONS_PER_TENANT`,
`DETAIL_MAX_CONCURRENT` менше за 2 × `DETAIL_MAX_PER_TENANT` або `DETAIL_DISK_BUDGET_BYTES` менше за
2 × `DETAIL_MAX_PER_TENANT` × найбільший знімок (~308 МіБ).

```bash
docker compose stop   # усі сервіси проєкту: старі процеси не працюють під час міграції
docker compose up -d postgres
# POSTGRES_PASSWORD діє лише для порожнього тому: власнику наявного тому пароль змінюють один раз.
# Через локальний сокет контейнера старий пароль не потрібен; \password рахує verifier на клієнті,
# тож пароль не потрапляє в лог Postgres. Введіть значення POSTGRES_PASSWORD із .env.
docker compose exec postgres psql -U flowforge -d flowforge -c '\password flowforge'
docker compose up --build --wait
```

Міграція `TenantIsolation` перед змінами перевіряє цілісність наявних даних і зупиняється з
кількістю порушень (без самих даних), якщо знайде задачу чи крок без свого виконання, рядок
невідомого тенанта або посилання між тенантами (див. «Міграції БД»).

Перевірено (18.11.2026) на томі, створеному попередньою версією (e2fadbf), з даними
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
sed -i.bak 's#^API_URLS=.*#API_URLS=http://localhost:3000#' .env.local
npm ci
npm run dev -- -p 3001
```

Параметр `-p` або `--port` має пріоритет над `PORT`. HTTP і WebSocket використовують ті самі `API_URLS` та `PUBLIC_ORIGIN`, завантажені до старту сервера. Під час SIGTERM фронтенд закриває підписки та дає HTTP-запитам до п’яти секунд на завершення.

### Приклади запитів

Команди створення тенанта, workflow і першого виконання наведено в [README](../README.md#приклади-запитів). Вони задають `API_URL`, `ADMIN_TOKEN`, `API_KEY` і `workflow_id`, які використовуються нижче. Заголовок `x-request-id` задає кореляційний ID. Якщо заголовок відсутній, API генерує ID і повертає його у відповіді.

Повтор запуску без ризику дубля — заголовок `Idempotency-Key` (до 255 видимих символів ASCII):
перший запит створює виконання (201), повтор того самого запиту повертає те саме виконання (200),
той самий ключ з іншим workflow чи входом — 422.

```bash
curl -fsS --max-time 15 "$API_URL/workflows/$workflow_id/run" -H "x-api-key: $API_KEY" \
  -H 'Idempotency-Key: order-42' -H 'content-type: application/json' -d '{"name":"Ada"}'
```

Виконання, що завершилось `failed` (зокрема після вичерпаних спроб, задача `dead`), можна
повторити: воно продовжиться з першого незавершеного кроку з новим бюджетом спроб, завершені кроки
не повторюються, а повторений крок `http` надсилає той самий `Idempotency-Key`.

```bash
: "${failed_execution_id:?Задайте ID виконання зі статусом failed}"
curl -fsS --max-time 15 -X POST "$API_URL/executions/$failed_execution_id/retry" -H "x-api-key: $API_KEY"
```

Поки виконання стоїть на паузі (`delay`), воно має статус `running`, а час пробудження видно в
`steps[i].wakeAt` відповіді `GET /executions/:id`.

Ліміти тенанта (3.3.4): перевизначення — під час створення або пізніше (`null` — значення за
замовчуванням); відповідь показує перевизначення й ефективні ліміти.

```bash
tenant_id="$(curl -fsS --max-time 15 "$API_URL/tenants" -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"limited-acme","limits":{"maxConcurrentExecutions":3,"rateLimit":100}}' | jq -er .id)"
curl -fsS --max-time 15 -X PATCH "$API_URL/tenants/$tenant_id/limits" -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"maxQueueSize":5000,"rateLimit":null}'
curl -fsS --max-time 15 "$API_URL/tenants/$tenant_id/limits" -H "x-admin-token: $ADMIN_TOKEN"
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
| GET/PUT/DELETE | `/tenants/me/notifications` | налаштування сповіщень: endpoint, `enabled`, ключі (секрет — лише у відповіді на створення) |
| POST / DELETE | `/tenants/me/notifications/secrets[/:keyId]` | ротація й відкликання ключа підпису сповіщень |
| GET | `/tenants/me/notifications/events[/:id]` | журнал подій (курсор, `status`, `limit` 1..100) і подія зі спробами |
| POST | `/tenants/me/notifications/events/:id/redeliver` | надіслати подію негайно ще раз (202; спроба триває — 409) |
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
одиночним сурогатом UTF-16 — 400: Postgres таких рядків не зберігає. Вкладеність
JSON (об'єкти й масиви) у тілі — до 64 рівнів, глибше — 400. Число, яке після
розбору змінилося б (`1e400`, `1e-400`, ціле чи дріб поза точністю double), — 400 з JSON-шляхом до
нього; точні числа на кшталт `0.1` зберігаються як надіслані. JSON-тіло — лише
валідний UTF-8: інша мітка `charset` — 415, невалідні байти — 400 (а не мовчазна заміна на U+FFFD).

| Що | Обмеження |
|---|---|
| `name` | рядок 1..200 символів; `enabled` — boolean |
| розклад | `cron` — 5 або 6 полів чи `@hourly` тощо, до 100 символів, з майбутнім моментом (порожній, 31 лютого, 7 полів — 400); `timezone` — ім'я зони IANA, 1..64 символи (зміщення `+03:00`, `local` — 400); `missedRunPolicy` — `skip` / `run_once` / `run_all` (за замовчуванням `run_once`, 3.3.8). У відповіді — `scheduleCursor`, `nextFireAt`, `scheduleBlockedSince` (черга тенанта повна), `scheduleError` (розклад попередньої версії не обчислюється) |
| `steps` | 1..50 кроків, унікальні `id` (`^[a-z][a-z0-9_]{0,31}$`), разом до 64 КіБ JSON |
| `http` | `url` до 2048 символів, лише `http://` / `https://`; `method` — `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`; `headers` — до 50 пар рядок → рядок (ім'я — token RFC 9110 до 256 символів, значення до 8 КіБ без CR/LF); заборонені `Idempotency-Key` (його ставить платформа) і службові заголовки з'єднання (`Host`, `Content-Length`, `Transfer-Encoding`, `Connection` тощо); `body` — рядок до 32 КіБ, лише для `POST`/`PUT`/`PATCH`/`DELETE` (у `GET`/`HEAD` тіла немає; метод за замовчуванням — `GET`) |
| `transform` / `log` | `expr` / `message` — до 4096 символів |
| `delay` | `ms` — ціле 0..2 592 000 000 (30 діб): пауза — довговічний таймер, слот воркера не тримає |
| вхід виконання | тіло `POST /workflows/:id/run` і webhook-а — JSON-об'єкт до 64 КіБ; webhook перевіряє вхід лише після підпису (без підпису — 401) |

### Інтерфейс тенанта

Після запуску Compose відкрийте [FlowForge](http://localhost:3001/login). Створіть тенанта через `POST /tenants` за прикладом вище й введіть його `apiKey` у формі входу. У розділі «Процеси» виберіть «Створити процес». Для першого запуску достатньо назви, кроку `log` з повідомленням і кнопки «Зберегти процес». На сторінці процесу введіть JSON-об’єкт, натисніть «Запустити» і відкрийте «Результат кроку». У розділі «Виконання» є фільтр стану та наступні сторінки. Посилання з процесу обмежує список його виконаннями.

«Редагувати» відкриває версію визначення з розкладом, таймзоною, політикою пропущених запусків та послідовністю кроків. Для збереженого HTTP-заголовка можна лишити значення, замінити його (порожній рядок теж є значенням) або видалити заголовок. Помилка форми залишає введені дані на сторінці. Після обриву під час створення перевірте список перед повтором. Кнопка повторного запуску з тим самим введенням використовує попередній ключ ідемпотентності після втрати відповіді.

[Swagger UI](http://localhost:3000/docs) описує HTTP API. [Документ OpenAPI](http://localhost:3000/docs-json) генерується із зареєстрованих контролерів. Для запитів тенанта введіть `X-API-Key`, для адміністрування — `X-Admin-Token`. Одноразова відповідь створення тенанта чи ротації містить секрет, який потрібно зберегти при видачі. Списки процесів і виконань повертають `items` та `nextCursor`. Курсор передається в наступний запит із тими самими фільтрами. Деталі виконання сумісні з повним JSON попередньої версії.

`GET /executions/:id` готує узгоджений знімок у тимчасовому файлі без імені, повертає з’єднання в пул і починає віддачу. Бюджет підготовки й віддачі — 60 с. Перед читаннями SQL отримує таймаут у межах залишку. Якщо PostgreSQL перестав відповідати на рівні транспорту, звільнення з’єднання залежить також від таймаутів драйвера. Знімки ділять спільний пул інстансу (див. «Спільні пули API» в розділі «Конфігурація»). Запит тенанта, який на цьому інстансі вже готує чи віддає `DETAIL_MAX_PER_TENANT` знімків (за замовчуванням 1), отримує `429 detail_in_progress`. Зайнятий пул, вичерпаний бюджет диска або сплив 60-секундного бюджету до початку віддачі дають `503`; обидві відповіді мають `Retry-After: 1`. Якщо бюджет спливає під час віддачі, API обриває з'єднання. Для інтерактивного перегляду доступні компактний `/summary` і окремі результати кроків.

Деталі процесу повертають `editRevision` як рядок. Передайте її в тілі PATCH для перевірки актуальності конфігурації. Сесії браузера вимагають цього поля (428), а запит із застарілою ревізією отримує 409 `workflow_edit_conflict`. API-клієнти з ключем можуть виконувати частковий PATCH без ревізії, якщо не використовують `{"keep":true}`. Збережені заголовки дозволено залишати лише з актуальною ревізією та без зміни URL чи ID кроку. Версія кроків зростає лише після зміни визначення, а хід планувальника не змінює ревізію редактора. `nextFireAt` містить дату, якщо планувальник зберіг момент після `scheduleCursor`. Інакше API повертає `null`. Якщо квота заблокувала перше спрацювання до збереження дати, перевіряйте `scheduleBlockedSince`.

### Межа довіри браузера

Сервер фронтенду обмінює введений ключ на відкличну сесію через `POST /sessions`. Браузер отримує HttpOnly cookie, PostgreSQL зберігає SHA-256 випадкового токена з терміном дії. Типово сесія живе 8 годин, зберігаються до 100 активних сесій тенанта. При вході зі зміною тенанта та при виході фронтенд відкликає попередню сесію. Помилка відкликання дозволяє повторити запит. Запити, що змінюють стан, вимагають збігу Origin. Відповіді з даними тенанта мають `private, no-store`. Стару cookie `ff_api_key` прибирає middleware.

За TLS задайте `PUBLIC_ORIGIN=https://<домен>` та `COOKIE_SECURE=true` для cookie `__Host-ff_session`. У локальному Compose використовується `http://localhost:3001` та `ff_session`. Якщо перед фронтендом є балансувальник, задайте його адреси в `FRONTEND_TRUST_PROXY` й налаштуйте перезапис forwarded-заголовків на зовнішній межі. Власний HTTP-сервер обчислює адресу з TCP-з’єднання й довірених переходів. API у Compose довіряє forwarded-заголовкам від фіксованої адреси фронтенду. Проксі пропускає дозволені маршрути та передає статус, `X-Request-Id`, `X-RateLimit-*` і `Retry-After` від API. Значення `queue_full` і `workflow_limit_reached` залежать від звільнення ресурсу, тому не мають часу повтору.

### Протокол WebSocket

1. Власник виконання робить `POST /executions/{id}/realtime-tickets`. Відповідь 201 містить `ticket` та `expiresAt`. За замовчуванням строк дії 30 секунд. Тикет прив’язаний до тенанта, виконання й браузерної сесії, якщо його видано за сесією.
2. Браузер відкриває `wss://<домен>/realtime?ticket=<ticket>` (локально `ws:`). Фронтенд перевіряє Origin. Будь-який інстанс API атомарно погашає тикет у PostgreSQL, реєструє підписку й читає знімок. Балансувальник має підтримувати WebSocket Upgrade й приховувати query цього маршруту в журналах доступу.
3. Сервер надсилає `{"type":"snapshot","execution":…}` зі схемою з `GET /executions/{id}/summary`. Ревізія — десятковий рядок bigint. Зміна стану виконання або його кроку оновлює ревізію в тій самій транзакції. PostgreSQL доставляє `NOTIFY` після commit. Знімок має план кроків і короткі стани. Окремі запити `steps/{index}` та `output` читають результат за дією користувача.
4. API оновлює підписки після відновлення LISTEN та кожні 15 секунд, коли також надсилає `{"type":"heartbeat"}`. На обрив браузер бере новий тикет з експоненційною затримкою та jitter. Після трьох невдач додатково опитує HTTP-знімок кожні 5 с; відповідь із `Retry-After` відкладає наступний запит щонайменше на цей час. Якщо за 45 с сокет не отримав жодного повідомлення (heartbeat чи знімок), клієнт закриває його й перепідключається. Клієнт замінює знімок за більшою ревізією свого виконання; за тієї самої ревізії чинний сокет або послідовне резервне опитування можуть оновити лише назву workflow. Код 4401 завершує сесію, 4404 означає недоступне виконання, 4008 — переповнений буфер, 1013 — тимчасово недоступне читання. Клієнтські повідомлення завершують підключення кодом 1003.
5. Один API типово приймає до 256 підписок, з них до 32 на тенанта. Одночасно читає до чотирьох знімків, об’єднує повторні повідомлення для підписки та обмежує буфер відправки до 256 КіБ. При зміні сторінки клієнт скасовує запити і таймери та закриває сокет.

WebSocket підтримує зміну API-інстансу й відкриття за одноразовим тикетом через той самий origin. SSE дозволив би передавати ті самі знімки, але автоматичний reconnect EventSource повторює початковий URL з уже погашеним тикетом. Обидва варіанти потребують перечитування PostgreSQL після розриву. Резервне HTTP-опитування використовує той самий контракт знімка.

### Перевірка браузером

Запустіть Compose з оверлеєм контрольного отримувача за інструкцією «Chaos- і навантажувальні сценарії». Із `apps/frontend` виконайте `npm ci`, `npx playwright install chromium` і `npx playwright test` з `ADMIN_TOKEN` тестового стенда в оточенні. Для перевірки втрати API задайте `COMPOSE_PROJECT_NAME` саме цього одноразового стенда. Тест зупиняє сервіс `api` та повертає його після перевірки. Для нестандартних портів задайте `API_ORIGIN`, `FRONTEND_ORIGIN` і відповідний `PUBLIC_ORIGIN`.


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
| `DB_POOL_SIZE` | `10` | найбільше з'єднань із Postgres в одному процесі, 5..1000, не менше за `WORKER_CONCURRENCY + 4`; сума пулів усіх процесів має вміщатися в `max_connections` Postgres (100 за замовчуванням) |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | межа одного SQL-запиту (`statement_timeout`) і простою відкритої транзакції (`idle_in_transaction_session_timeout`), 100..600000 мс; на CLI міграцій не діє |
| `ADMIN_TOKEN` | — (обов'язкова лише для API, ≥ 12 символів, секрет) | токен службових ендпоінтів `/tenants…`; воркер його не отримує й без нього стартує; у `NODE_ENV=production` приклад і очевидні заглушки заборонені (див. нижче); у `.env.example` — закоментована підказка |
| `ADMIN_RATE_LIMIT` / `ADMIN_RATE_WINDOW_MS` | `30` / `60000` | запитів до `/tenants…` з однієї IP-адреси за вікно (1..10000 / 1000..3600000 мс); рахується кожен запит ще до перевірки токена |
| `AUTH_FAILURE_RATE_LIMIT` / `AUTH_FAILURE_RATE_WINDOW_MS` | `30` / `60000` | невдалих автентифікацій (невірний `x-api-key`, невірний підпис webhook-а, webhook невідомому workflow) з однієї IP-адреси за вікно; понад це — 429 замість 401/404, успішні запити не рахуються |
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
| `JOB_RETENTION_DAYS` | `30` | скільки днів зберігати завершені задачі (`done`/`failed`/`dead`) у `jobs`, 1..3650; виконання й кроки не видаляються |
| `EXECUTION_RETENTION_DAYS` | `0` | скільки днів зберігати історію завершених виконань (з кроками й задачами), 0..3650; `0` — зберігати завжди (за замовчуванням: історію тенанта без явного рішення оператора не видаляємо). Квитанції вхідних webhook-ів (`webhook_deliveries`, рядок на прийняту доставку) цей строк не очищає: вони живуть, доки існує workflow, і дедуплікують перепідписаний повтор доставки будь-коли (`docs/architecture.md`, 3.3.7) |
| `JOB_CLEANUP_INTERVAL_MS` | `3600000` | таймер кожного воркера між очищеннями старих задач, увімкненої історії та між завершеними обходами версій workflow, 1000..2147483647 мс, з відхиленням ±50%; спільна мінімальна пауза між обходами версій — чверть інтервалу (див. нижче) |
| `SCHEDULER_TICK_MS` | `30000` | період тіку планувальника, 100..60000 мс: без перешкод вчасний момент обробляється на найближчому тіку; зайнятий рядок, повна черга чи квота outbox і простій відкладають спрацювання (README 3.3.8); тік читає лише належні розклади |
| `SCHEDULER_MISFIRE_GRACE_MS` | `60000` | момент розкладу, старший за стільки мс на час обробки, — пропущений і йде за `missedRunPolicy` workflow, 1000..2147483647, не менше за `SCHEDULER_TICK_MS` |
| `OUTBOX_CONCURRENCY` | `4` | циклів доставки сповіщень на воркер, 0..64 (`0` — воркер сповіщень не надсилає) |
| `OUTBOX_TENANT_IN_FLIGHT` | `2` | одночасних спроб доставки одного тенанта в усьому кластері, 1..64: повільний endpoint не займає всіх циклів |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | пауза, коли надсилати нічого, 10..60000 мс, з відхиленням ±50% |
| `OUTBOX_HTTP_TIMEOUT_MS` | `10000` | таймаут однієї спроби доставки, 100..60000 мс; транспорт застосовує мінімум із цим значенням та `HTTP_STEP_TIMEOUT_MS`; lease спроби — `2 ×` таймаут `+ 5 с` |
| `OUTBOX_BACKOFF_BASE_MS` / `OUTBOX_BACKOFF_MAX_MS` | `5000` / `3600000` | backoff між спробами (експоненційний, повний jitter, не раніше за `Retry-After`); стеля — найдовша пауза: спроб без ліміту, недоставлена подія не видаляється |
| `OUTBOX_RETENTION_DAYS` | `7` | скільки днів зберігати доставлені або явно скасовані тенантом події, 1..3650 |
| `REALTIME_MAX_CONNECTIONS` / `REALTIME_MAX_CONNECTIONS_PER_TENANT` | `256` / `32` | WebSocket-підписок на інстанс API і з них одного тенанта (2..10000 / 1..1000); перша — не менше за 2 × другу |
| `DETAIL_MAX_CONCURRENT` / `DETAIL_MAX_PER_TENANT` | `8` / `1` | одночасних знімків `GET /executions/:id` на інстанс API (2..256) і з них одного тенанта (1..16); перша — не менше за 2 × другу |
| `DETAIL_DISK_BUDGET_BYTES` | `1073741824` | диск тимчасових файлів знімків інстансу, байт; не менше за 2 × `DETAIL_MAX_PER_TENANT` × найбільший знімок (~308 МіБ) |
| `TEST_DATABASE_URL` | `postgres://flowforge:flowforge@localhost:5432/flowforge_test` | лише для інтеграційних тестів |

Воркер видаляє знімки, що не є поточною версією і на які не посилається жодне виконання, незалежно від `EXECUTION_RETENTION_DAYS`. Кожна транзакція переглядає до 500 ID, записує позицію в PostgreSQL і звільняє блокування. Поки обхід триває, воркер бере наступну порцію через 1–2 с. Після завершення обходу кожен воркер планує наступну спробу за власним таймером (0,5–1,5 × `JOB_CLEANUP_INTERVAL_MS`). Спільну межу тримає PostgreSQL: новий обхід починається не раніше ніж через чверть інтервалу (типово 15 хв) після завершення попереднього, а раніший виклик повертає `(0, false)`. Момент завершення зберігається в `workflow_version_cleanup`. Тож із кількома воркерами обходи можуть іти частіше за `JOB_CLEANUP_INTERVAL_MS`, але не частіше за його чверть.

**Спільні пули API.** Деякі ресурси інстансу API спільні для всіх тенантів: WebSocket-підписки й знімки `GET /executions/:id` (кількість і диск тимчасових файлів). Правило для кожного такого пулу: частка одного тенанта не більша за половину пулу, і процес не стартує з конфігурацією, що його порушує. Тимчасова відмова через зайнятість пулу несе `Retry-After`. Межі діють на інстанс: кожен інстанс API має власний пул.

**Змінні кроку міграцій** (`migrate` у compose; не входять до конфігурації API й воркера, а
`MIGRATION_DATABASE_URL` у їхньому оточенні — помилка валідації):

| Змінна | За замовчуванням | Опис |
|---|---|---|
| `MIGRATION_DATABASE_URL` | — (обов'язкова для `migration:*` і `db:provision`) | власник схеми — **суперкористувач** Postgres: міграції створюють роль із BYPASSRLS і заповнюють таблиці під `FORCE ROW LEVEL SECURITY`, що інакше не бачило б рядків |
| `API_DB_USER` / `API_DB_PASSWORD` | `flowforge_api` / — | login-роль API; `db:provision` створює її або оновлює пароль (ротація) |
| `WORKER_DB_USER` / `WORKER_DB_PASSWORD` | `flowforge_worker` / — | login-роль воркера; ім'я має відрізнятися від ролі API |
| `TENANT_MAX_RUNNING` | `10` | ліміт одночасних задач тенанта за замовчуванням, 1..1000 |
| `TENANT_MAX_QUEUE_SIZE` | `100000` | ліміт незавершених задач тенанта за замовчуванням, 1..10000000 |
| `TENANT_MAX_WORKFLOWS` | `1000` | квота збережених workflow тенанта за замовчуванням, 1..100000 |
| `TENANT_MAX_OUTBOX_EVENTS` | `200000` | квота outbox: недоставлені події разом із незавершеними виконаннями тенанта, 1..10000000; заповнена — нові постановки й redeliver дають 429 `outbox_full`, cron відкладає |
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
pg_port="$(setting POSTGRES_PORT)"
export MIGRATION_DATABASE_URL="postgres://flowforge:$(setting POSTGRES_PASSWORD)@localhost:${pg_port:-5432}/flowforge"
npm run db:migrate          # застосувати й звірити інваріанти безпеки (одна транзакція)
# створити/оновити ролі flowforge_api і flowforge_worker та значення лімітів за замовчуванням
API_DB_PASSWORD="$(setting API_DB_PASSWORD)" WORKER_DB_PASSWORD="$(setting WORKER_DB_PASSWORD)" \
  TENANT_MAX_RUNNING="$(setting TENANT_MAX_RUNNING)" TENANT_MAX_QUEUE_SIZE="$(setting TENANT_MAX_QUEUE_SIZE)" \
  TENANT_MAX_WORKFLOWS="$(setting TENANT_MAX_WORKFLOWS)" TENANT_MAX_OUTBOX_EVENTS="$(setting TENANT_MAX_OUTBOX_EVENTS)" \
  TENANT_RATE_LIMIT="$(setting TENANT_RATE_LIMIT)" TENANT_RATE_WINDOW_MS="$(setting TENANT_RATE_WINDOW_MS)" \
  TENANT_WEBHOOK_RATE_LIMIT="$(setting TENANT_WEBHOOK_RATE_LIMIT)" TENANT_WEBHOOK_RATE_WINDOW_MS="$(setting TENANT_WEBHOOK_RATE_WINDOW_MS)" \
  npm run db:provision
npm run migration:revert    # відкотити останню
npm run migration:show      # стан
# нова міграція з різниці між сутностями і БД (потім додати її в migrations/index.ts):
migration_name=DescribeSchemaChange
npm run build && npm run migration:generate -- "src/database/migrations/$migration_name"
```

Наявні міграції:

- `InitialSchema` — базова міграція схеми стартового репозиторію (як її будував `synchronize`).
  UUID генеруються вбудованою `gen_random_uuid()` (Postgres 13+), тож розширення й права на
  `CREATE EXTENSION` не потрібні.
- `AddCorrelationId` — колонка `correlationId` у `executions` і `jobs`.
- `TimestampsWithTimeZone` — `createdAt` у `tenants`, `workflows`, `executions`, `jobs` і
  `step_runs.startedAt`: `timestamp` → `timestamptz`. Наявні значення
  перетворюються `USING "<колонка>" AT TIME ZONE current_setting('TimeZone')`: їх записав
  `DEFAULT now()` як час у поясі сесії, а сесія успадковує пояс сервера БД. Для сервера в UTC
  (як у compose) це те саме, що `AT TIME ZONE 'UTC'`; для сервера в іншому поясі жорстко заданий
  UTC зсунув би всі рядки (це перевіряє інтеграційний тест). Припущення: пояс сервера не
  змінювався відтоді, як рядки записано. `ALTER TYPE` переписує таблиці й перебудовує індекс
  `executions (tenantId, createdAt)` під `ACCESS EXCLUSIVE` — на великих таблицях потрібне вікно
  обслуговування. `down` виконує зворотне перетворення в тому самому поясі.
- `QueueLease` — fencing-токен `jobs.lockToken`; часткові індекси `IDX_jobs_claim` і
  `IDX_jobs_lease` замість `(status, "runAt")`.
- `StepCheckpoints` — `step_runs.attempts`, `finishedAt`, унікальний `(executionId, stepIndex)`;
  дублікати спроб стартового коду згортаються до одного рядка на крок.
- `WorkflowVersions` — таблиця `workflow_versions`, `executions.workflowVersionId` (FK, `CHECK`);
  версії для наявних workflow, прив'язка наявних виконань, незавершені виконання видалених
  workflow завершуються як `failed`.
- `DurableTimers` — `step_runs.wakeAt`.
- `StepIdempotencyKey` — `step_runs.idempotencyKey` (унікальний; наявні рядки отримують власний UUID).
- `JobFinishedAt` — `jobs.finishedAt` і частковий індекс `IDX_jobs_finished` для очищення; наявні завершені задачі отримують момент завершення свого виконання (або момент
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

**База стартового коду не оновлюється.** БД, яку створив стартовий код (`main@b17a0b3`, схема
через `synchronize`, без журналу міграцій), штатні міграції не підтримують: перевірка прав каталогу
відхиляє функції розширення `uuid-ossp`, доступні `PUBLIC`, а кроки `http` у стані `running` не мали
ключа ідемпотентності, тож їхній ефект після оновлення не звірити автоматично. Не позначайте
`InitialSchema` виконаною вручну: розгортайте рішення з порожнім томом `pgdata` (README, «Що не
встигли або зробили б інакше»).


## Тести

Команди встановлення залежностей, підключення до тестової БД та запуску наведено в [README](../README.md#тести).

- `test/unit` — швидкі тести без інфраструктури (`test/jest-unit.json`).
- `test/integration` — тести на реальному Postgres (`test/jest-integration.json`). Перед
  прогоном глобальний setup створює базу `flowforge_test` (якщо її немає), **видаляє схему
  `public` і будує її міграціями з нуля** — тож кожен прогін заодно перевіряє міграції.
  Запуск дозволений лише на базі з суфіксом `_test`. Файли виконуються послідовно; кожен тест
  очищає таблиці (`test/helpers/db.ts`). Локально достатньо `docker compose up -d postgres` і
  адреси тестової БД власником (суперкористувачем). Команди README беруть пароль і порт для
  `TEST_DATABASE_URL` із кореневого `.env`.
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
- Планувальник (3.3.8): `scheduler-instances` (два інстанси на одному моменті, гонка над багатьма
  розкладами, обрив з'єднання посеред проходу, невідомий COMMIT, SIGTERM), `scheduler-progress`
  (рестарт, помилка постановки, моменти до появи workflow), `scheduler-missed` (політики, редагування,
  очищення історії, несправний розклад), `scheduler-timezone`, `scheduler-locks`, `scheduled-fairness`;
  unit `cron-schedule.spec.ts` (DST із заздалегідь визначеними моментами й незалежний еталон).
- Сповіщення (3.3.9): `outbox-atomicity` (чотири шляхи завершення, `/retry`, відкат), `outbox-delivery`
  (втрачене підтвердження, збій до запису, запізнілий результат, редирект, політика адрес, backoff без
  ліміту, `Retry-After`, ізоляція повільного endpoint-а), `notification-settings` (секрет один раз,
  ротація, зміна адреси, пауза, скасування, курсор, RLS, секрети поза логами), `outbox-metrics`,
  `scheduler-outbox-e2e` (два планувальники, воркер окремим процесом і ще один відправник).
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
  `correlationId`, тож логи кроків пов'язані з вихідним запитом. Спрацювання cron має
  детермінований ID `cron:<workflowId>:<scheduledAt, мс>`. Крок `http` і доставка сповіщення
  надсилають ID заголовком `x-request-id`; ланцюжок і поведінка при `/retry` — 3.3.10.
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

  Воркер, сповіщення (`src/outbox/outbox.metrics.ts`):

  | Метрика | Тип | Що |
  |---|---|---|
  | `flowforge_outbox_attempts_total{outcome}` | counter | спроби доставки: `delivered`, `http_error`, `redirect`, `timeout`, `network`, `denied`, `paused`, `aborted`, `stale` (результат спроби, чий lease перехопили) |
  | `flowforge_outbox_attempt_duration_seconds{outcome}` | histogram | тривалість спроби від захоплення до запису результату |
  | `flowforge_outbox_events{state}` | gauge | недоставлені події кластера: `pending`, `sending` (з БД) |
  | `flowforge_outbox_pending{tenant_id}` | gauge | недоставлені події тенанта (з БД) |
  | `flowforge_outbox_oldest_pending_age_seconds` | gauge | вік найстарішої недоставленої події, с (0 — немає) |
  | `flowforge_outbox_claim_failures_total`, `flowforge_outbox_due_repairs_total`, `flowforge_outbox_purged_total`, `flowforge_outbox_backlog_collect_errors_total` | counter | невдалі захоплення (БД недоступна); перераховані підказки `dueAt`; видалені доставлені й скасовані події; невдалі читання беклогу |

  API, планувальник (`src/scheduler/scheduler.metrics.ts`):

  | Метрика | Тип | Що |
  |---|---|---|
  | `flowforge_schedule_firings_total{outcome}` | counter | оброблені моменти: `created`, `existing` (виконання вже було), `missed_skipped`, `missed_run_once` |
  | `flowforge_schedule_blocked_total{reason}` | counter | спроби, відкладені через квоту черги (`queue_full`) або outbox (`outbox_full`); курсор не рухається |
  | `flowforge_schedule_errors_total{reason}` | counter | `invalid_schedule` (розклад не обчислюється), `database` (помилка обробки одного workflow) |
  | `flowforge_schedule_lag_seconds` | histogram | від запланованого моменту до створення виконання, за годинником БД |
  | `flowforge_scheduler_tick_duration_seconds` | histogram | тривалість тіку |

  **Між інстансами:** лічильники й гістограми — процесу (`sum` по інстансах); gauge-і з БД
  (`flowforge_queue_depth`, `flowforge_outbox_*` беклогу) однакові на кожному воркері — `max`. Мітки
  — лише з фіксованого набору й `tenant_id`; URL, секрети й ID подій у мітки не потрапляють
  (`outbox-metrics.int-spec.ts`).

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


## Сповіщення: отримувач і оператор

Після кожного завершення виконання (`succeeded` або `failed`, зокрема `dead`) платформа надсилає
тенанту підписане сповіщення з гарантією «щонайменше один раз» (ТЗ 3.3.9). Рішення й
альтернативи — у [3.3.9](architecture.md#339-вихідні-події). Тут — контракт для розробника отримувача й
інструкція для оператора.

### Налаштування

```bash
# Endpoint (лише https://, публічний хост, без облікових даних у URL). Перша відповідь — єдина,
# де видно секрет підпису: збережіть його одразу.
curl -X PUT localhost:3000/tenants/me/notifications -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' -d '{"url":"https://hooks.example.com/flowforge"}'
# {"url":"…","enabled":true,"revision":1,"keys":[{"id":"…","role":"current"}],"secret":"<64 hex>"}

curl localhost:3000/tenants/me/notifications -H "x-api-key: $API_KEY"        # без секретів
curl -X PUT localhost:3000/tenants/me/notifications -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' -d '{"url":"https://hooks.example.com/flowforge","enabled":false}'
curl -X DELETE localhost:3000/tenants/me/notifications -H "x-api-key: $API_KEY"
```

| Дія | Що з подіями |
|---|---|
| Створення (`PUT`, налаштувань ще немає) | події з'являються для завершень **після** цього моменту; минулі завершення сповіщень не створюють |
| Зміна URL (`PUT`) | `revision` +1; кожна наступна спроба, зокрема події, що вже чекають, іде на новий URL. Спроба, яка вже триває, завершується на старий |
| `enabled: false` | пауза доставки: нові завершення далі створюють події, вони й ті, що вже чекають, лишаються `pending` і доставляються після `enabled: true` |
| `DELETE` | відписка: нові завершення подій не створюють. Прийняті події лишаються `pending` і автоматично доставляються, щойно тенант налаштує endpoint знову, з тими самими ID і байтами. Спроба, що триває, повертається в `pending` (outcome `paused`), і її пізня відповідь нічого не змінює |
| `POST …/events/discard` | явна відмова тенанта від недоставлених подій, створених до запиту: `pending` → `cancelled`, відповідь `{"discarded": n}`. Запит просувається порціями за часом створення та ID. Оновлення чекає на конкурентні записи в межах таймауту БД. Якщо запит завершився помилкою, підтверджені порції лишаються скасованими, решту можна скасувати повторним запитом. Спроби, що тривають, не перериваються. Скасовані події видаляються через `OUTBOX_RETENTION_DAYS` |
| Ротація ключа | див. нижче; події, що чекають, підписуються ключами, чинними на момент спроби |

Адреса перевіряється двічі: під час збереження (схема, облікові дані, DNS і політика адрес) і під
час **кожного** з'єднання (та сама політика, що й у кроків `http`, 3.3.6: приватні діапазони,
loopback, службові адреси хмар, IPv4-mapped, адреси самого хоста, `HTTP_DENY_CIDRS`). Тож зміна DNS
після збереження не відкриває доступу до внутрішньої мережі: спроба отримує `denied` і чекає далі.

### Контракт події (версія 1)

`POST <url>`, `content-type: application/json`. Тіло — JSON, серіалізований **один раз** під час
створення події; кожна спроба надсилає ті самі байти.

```json
{
  "specVersion": 1,
  "id": "6f1c…",
  "type": "execution.succeeded",
  "createdAt": "2026-11-19T10:00:01.123Z",
  "tenantId": "…",
  "correlationId": "cron:<workflowId>:1795111662000",
  "data": {
    "executionId": "…",
    "sequence": 1,
    "workflowId": "…",
    "workflowVersion": 3,
    "status": "succeeded",
    "trigger": "cron",
    "scheduledAt": "2026-11-19T10:00:00.000Z",
    "finishedAt": "2026-11-19T10:00:01.100Z",
    "error": null
  }
}
```

- `type` — `execution.succeeded` або `execution.failed`; `data.error` — текст помилки (до 1000
  символів) або `null`. Результат (`output`) і вхід у подію не потрапляють: подія «тонка», результат
  — `GET /executions/:executionId`.
- `data.sequence` — номер циклу виконання: ручний `/retry` відкриває новий цикл, і його завершення —
  **нова подія** з новим `id` і `sequence` 2, 3, … Подія попереднього циклу не змінюється.
- `id` — стабільний ідентифікатор логічної події. Повтор доставки (втрачене підтвердження, збій
  відправника) приходить з тим самим `id` і тими самими байтами.
- Нові поля можуть з'являтися в межах `specVersion: 1`; несумісна зміна — лише з новою версією.

Заголовки кожної спроби:

| Заголовок | Значення |
|---|---|
| `x-flowforge-event-id` | `id` події, однаковий для всіх спроб |
| `x-flowforge-timestamp` | час **цієї** спроби, Unix-секунди (за годинником БД) |
| `x-flowforge-attempt` | номер спроби: 1, 2, … |
| `x-flowforge-signature` | `v1=<hex>` — HMAC-SHA256; під час ротації два значення через кому: `v1=<hex>, v1=<hex>` |
| `x-request-id` | кореляційний ID трасування, що завершило виконання (той самий, що в `correlationId`) |

Підпис: `HMAC-SHA256(secret, "v1\n" + id + "\n" + timestamp + "\n" + <сирі байти тіла>)`, hex.
Перевіряти саме сирі байти (до розбору JSON), порівнювати без витоку часу, вікно часу — на розсуд
отримувача (у прикладі — 5 хвилин).

### Приклад отримувача: підпис і дедуплікація

<!-- receiver-example: цей блок виконує test/unit/readme-receiver.spec.ts -->
```js
const { createHmac, timingSafeEqual } = require('node:crypto');

const WINDOW_SECONDS = 300;

/** Підпис одним із секретів (під час ротації — поточний і новий) і час у вікні. */
function verify(headers, rawBody, secrets, now = Math.floor(Date.now() / 1000)) {
  const id = headers['x-flowforge-event-id'];
  const timestamp = headers['x-flowforge-timestamp'];
  const signature = headers['x-flowforge-signature'];
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string')
    return false;
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > WINDOW_SECONDS)
    return false;
  const provided = signature
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^v1=[0-9a-f]{64}$/.test(part))
    .map((part) => Buffer.from(part.slice(3), 'hex'));
  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret)
      .update(`v1\n${id}\n${timestamp}\n`)
      .update(rawBody)
      .digest();
    return provided.some((mac) => timingSafeEqual(mac, expected));
  });
}

/**
 * Обробка «щонайменше один раз»: дубль події (той самий id) — 2xx без повторної дії. Запис id
 * і сама дія мають фіксуватися атомарно (одна транзакція з унікальним індексом на id), інакше
 * збій між ними дасть або втрату, або повтор дії.
 */
async function handle(headers, rawBody, secrets, store) {
  if (!verify(headers, rawBody, secrets)) return 401;
  const event = JSON.parse(rawBody.toString('utf8'));
  if (event.id !== headers['x-flowforge-event-id']) return 400;
  // transaction повертає результат після COMMIT. Виняток відкочує обидва записи
  // і доходить до HTTP-обробника, який відповідає 5xx.
  return store.transaction(async (tx) => {
    if (!(await tx.insertIfAbsent(event.id))) return 200;
    await tx.applyEvent(event);
    return 204;
  });
}

module.exports = { verify, handle };
```

Відповідь 2xx — подія доставлена. Будь-що інше (3xx, 4xx, 5xx, таймаут `OUTBOX_HTTP_TIMEOUT_MS`,
обрив) — спроба невдала, подія буде повторена. Редиректам відправник **не** слідує: 301/302/303
перетворили б POST на GET без тіла. `Retry-After` враховується в межах `OUTBOX_BACKOFF_MAX_MS`.
Порядок доставки подій **не гарантується** (повтор однієї може прийти після наступної): упорядковуйте
за `data.finishedAt` і `data.sequence`.

### Ротація секрету без простою

1. `POST /tenants/me/notifications/secrets` — новий ключ `next`; секрет — лише в цій відповіді
   (`{"id":"…","secret":"…"}`, `Cache-Control: no-store`). Відтепер кожна спроба має два підписи.
2. Отримувач додає новий секрет до списку (`verify(…, [old, new])`) і розгортається.
3. `DELETE /tenants/me/notifications/secrets/<id старого ключа>` — підписи лише новим. Останній
   ключ не відкликається (409); друга ротація, поки є `next`, — 409.

Ключ, яким підписано кожну спробу, записано в журналі (`keyIds`), тож після ротації видно, чи
доходили вже підписи новим ключем.

### Сторінки історії спроб

`GET /tenants/me/notifications/events/:id?limit=50` повертає поля події, масив `attempts` та `nextAttemptsCursor`. Ліміт 1–100. Наступний запит додає `cursor` до того самого маршруту. Значення `null` завершує обхід. Перша сторінка фіксує останній номер спроби. Нові номери потраплять до нового обходу, результат активної спроби може оновитися. Курсор прив’язаний до події, доступ до неї перевіряється в контексті тенанта на кожній сторінці.

Без параметрів клієнт отримує всі збережені спроби у попередньому форматі й у порядку номера. Історія зберігає до 20 записів: першу й останні 19 спроб. З'єднання БД утримується лише під час читання порції. На цей час FOR KEY SHARE зберігає рядок події разом зі спробами, а очищення пропускає його через SKIP LOCKED. Після COMMIT очищення може видалити доставлену подію за політикою зберігання. Наступний запит тоді повертає 404.

**Історичне вимірювання до обмеження журналу.** Node 20.19.4, PostgreSQL 16. Для кожного розміру та режиму запускався окремий процес API. Клієнт читав байти HTTP. У таблиці приріст максимального RSS процесу проти його прогрітого максимуму в МіБ (1 МіБ = 1 048 576 байтів). Значення пам'яті залежать від платформи та збирача сміття.

| Спроб | Старий GET, байтів / приріст RSS | Потоковий GET, байтів / приріст RSS | Сторінка 50, байтів / приріст RSS |
|---:|---:|---:|---:|
| 100 | 18 336 / 0,00 | 18 336 / 0,05 | 9 417 / 0,06 |
| 10 000 | 1 819 238 / 4,11 | 1 819 238 / 3,16 | 9 419 / 0,16 |
| 100 000 | 18 289 239 / 77,31 | 18 289 239 / 24,53 | 9 421 / 0,08 |

Поточна перевірка вимірює обсяг збереженої історії для загальних лічильників 100, 10 000 і 100 000 спроб. На PostgreSQL 16 отримано 3 944–4 027 байтів для події з тестовим тілом і 20 спробами. Критерій для цієї фікстури — менш ніж 8 КіБ у кожному режимі. Прогін також виводить пік RSS і приріст heap. Команда в `apps/api` на ізольованій `TEST_DATABASE_URL` із суфіксом `_test` — `npm run build && npm run bench:claim -- --runInBand attempt-history`.

### Оновлення з першої версії outbox

Зупиніть API та воркери й виконайте штатний `db:migrate`. Міграція `SerializeOutbox` перераховує підказки й переводить недоставлені події без налаштувань у `cancelled`. `OutboxPause` зберігає скасування, бо стара схема не містить його причини. Для таких подій строк зберігання починається в момент міграції. Звірте журнал і поверніть на доставку лише погоджені ID через `redeliver`. Незавершене виконання після оновлення створює подію штатним переходом. Успадковані короткі cron отримують `scheduleError` та `nextFireAt = NULL`, зберігаючи текст і курсор. Для відновлення задайте валідний cron через PATCH.

Якщо стара гонка вже відбулася і endpoint після видалення було створено знову, попередня схема не зберігає покоління конфігурації. Для такого тенанта після міграції запустіть лише API і виконайте звірку, поки воркери зупинені.

1. Якщо endpoint налаштований, виконайте `DELETE /tenants/me/notifications`. Доставка призупиниться, а активні спроби повернуться в `pending`. Запит, який уже пішов до отримувача, може в нього завершитися. Скидання токена захищає стан події від пізньої відповіді.
2. Звірте ID із журналом отримувача. Щоб відмовитися від усієї недоставленої черги, виконайте `POST /tenants/me/notifications/events/discard` і перевірте за журналом, що спірні події скасовано.
3. Поверніть лише узгоджені ID через `redeliver`, створіть налаштування через `PUT /tenants/me/notifications` і запустіть воркери.

### Для оператора: недоставлені події

```bash
# Журнал подій тенанта: найновіші першими, курсорна пагінація (limit 1..100), фільтр за станом.
curl -fsS --max-time 15 "$API_URL/tenants/me/notifications/events?status=pending&limit=20" -H "x-api-key: $API_KEY"

: "${event_id:?Задайте ID події з журналу}"
# Подія з точними байтами й усіма спробами (номер, відправник, ревізія endpoint-а, ключі,
# результат, HTTP-статус, тривалість).
curl -fsS --max-time 15 "$API_URL/tenants/me/notifications/events/$event_id" -H "x-api-key: $API_KEY"
# Надіслати негайно (той самий id і байти), без очікування backoff; також для delivered/cancelled.
# Без налаштувань подія чекає pending і піде після наступного PUT.
curl -fsS --max-time 15 -X POST "$API_URL/tenants/me/notifications/events/$event_id/redeliver" -H "x-api-key: $API_KEY"
```

Стани: `pending` (чекає спроби; `nextAttemptAt` — коли), `sending` (спроба триває; lease
`2 × OUTBOX_HTTP_TIMEOUT_MS + 5 с`), `delivered`, `cancelled` (лише явна відмова тенанта, `cancelledAt`). `lastError` — клас останньої невдачі:
`http_error`, `redirect`, `timeout`, `network`, `denied`, `paused`, `aborted`. Через усі тенанти —
власником схеми (повз RLS):

```sql
-- найстаріші недоставлені події
SELECT id, "tenantId", attempts, "lastError", "lastStatus", "nextAttemptAt", "createdAt"
  FROM outbox_events WHERE status IN ('pending', 'sending') ORDER BY "createdAt" LIMIT 20;
-- спроби однієї події
SELECT attempt, "senderId", revision, "keyIds", outcome, "httpStatus", "durationMs", "startedAt"
  FROM outbox_attempts WHERE "eventId" = '<eventId>' ORDER BY attempt;
-- від події до виконання й трасування
SELECT e.id, e."executionId", e.sequence, e."correlationId", x.status, x.trigger
  FROM outbox_events e JOIN executions x ON x.id = e."executionId" WHERE e.id = '<eventId>';
```

Метрики (воркер): `flowforge_outbox_events{state}`, `flowforge_outbox_pending{tenant_id}`,
`flowforge_outbox_oldest_pending_age_seconds` — сигнал «endpoint тенанта давно не приймає»;
`flowforge_outbox_attempts_total{outcome}` — частка невдач за класом. У логах воркера кожна спроба
— з `eventId`, `attempt`, `outcome`, `httpStatus` у контексті `correlationId` події: за ним у логах
API та воркера видно запит чи спрацювання, виконання, кроки й усі спроби доставки.

**Межі гарантії.** Прийнята подія доставляється щонайменше один раз, щойно в тенанта є увімкнений
endpoint, який колись відповість 2xx. Видалення чи вимкнення налаштувань — пауза, а не втрата; від
події відмовляється лише сам тенант (`discard`). Спроб без ліміту, пауза між ними зростає до
`OUTBOX_BACKOFF_MAX_MS` (1 год), недоставлену подію не видаляє ніщо. Поки endpoint недоступний,
події накопичуються до квоти тенанта `maxOutboxEvents` (недоставлені разом із незавершеними
виконаннями; `TENANT_MAX_OUTBOX_EVENTS`). Далі нові постановки й redeliver цього тенанта
отримують 429 `outbox_full`, cron відкладає спрацювання, а прийняті події лишаються. Історія
спроб зберігає першу й останні 19 спроб кожної події, а лічильник `attempts` події лишається
повним. Найгірший виміряний рядок — близько 1,7 КіБ події з помилкою на 1000 символів і 0,2 КіБ
спроби, тож одна недоставлена подія з повною історією займає близько 5,7 КіБ без індексів. Доставлені та явно
скасовані події видаляються через `OUTBOX_RETENTION_DAYS`. Подія створюється, якщо в момент завершення в тенанта є налаштування
(увімкнені чи на паузі). Один повільний чи недоступний endpoint займає щонайбільше
`OUTBOX_TENANT_IN_FLIGHT` спроб одночасно в усьому кластері, решта тенантів отримує сповіщення далі.


## Chaos- і навантажувальні сценарії

Після переходу на захищений транспорт (19.11.2026) обидва сценарії пройшли на окремому Compose з PostgreSQL 16 і двома воркерами. На 200 виконань із SIGKILL отримувач побачив 208 запитів та 200 ефектів. На окремі 200 виконань із двома рестартами PostgreSQL отримувач побачив 216 запитів та 200 ефектів. В обох прогонах усі виконання успішні, жодного зміненого завершеного чекпоінту та жодної dead job. Команди нижче.

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
`log → http (sink) → delay 2 с → log`). У кожному раунді скрипт спершу фіксує вже завершені
кроки, включно з HTTP. Для останнього виконання приймач утримує першу HTTP-відповідь, доки
скрипт заблокує рядок його чекпоінта. Скрипт відпускає відповідь і з окремої сесії чекає, поки воркер заблокується
на записі. Тоді зупиняє Postgres через SIGKILL і запускає той самий контейнер. Кожен раунд
чекає, поки БД знову стане healthy. Перевіряє все те саме, що й сценарій із вбивством воркерів, і ще:
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

### Сповіщення: рестарт Postgres і втрачені підтвердження (3.3.9)

```bash
# стек з оверлеєм — як у «Вбивство воркерів під навантаженням»
(cd apps/api && npm run chaos:notifications)
```

Сценарій (`scripts/chaos-notifications.ts`) налаштовує сповіщення тенанта на `sink`, запускає 50
виконань, кожне зі своїм `x-request-id`, і перезапускає Postgres, коли частину подій уже створено,
а доставку ще не завершено. `sink` приймає тіло кожної першої доставки події й обриває з'єднання без
відповіді (втрачене підтвердження). Критерії: рівно одна подія на виконання, кожна подія отримана
щонайменше двічі з тим самим `id` і побайтово однаковим тілом, підпис кожної доставки чинний,
`x-request-id` — той, з яким запущено виконання. Будь-яке порушення — ненульовий код виходу. У CI
сценарій іде після інших chaos-сценаріїв; результат — 50 подій, 100 доставок і нуль порушень.

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
3. «B під backlog-ом A» — ті самі 30 виконань B, поки черга A глибока, а endpoint сповіщень A
   повертає 503. Скрипт перевіряє за журналом спроб, що відмова доставки відбулась під час цієї
   фази.

Після кожного прогону скрипт ставить доставки A на паузу й прибирає залишок невиконаних задач.
Коли чинні спроби завершилися або їхні lease спливли, він видаляє налаштування сповіщень і
скасовує чергу через `discard`. Наступний прогін «B сам» починається після очищення.

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
# тестова БД власником схеми — як у README, «Тести»; .env з кореня репозиторію
(cd apps/api && TEST_DATABASE_URL="$(node scripts/test-database-url.cjs)" &&
  export TEST_DATABASE_URL && npm run bench:claim)
```

`test/bench/claim.bench-spec.ts` — справжній `JobQueueService` у двох Nest-застосунках з окремими пулами БД і спільним циклом подій одного процесу Node.js, по 16
паралельних циклів (32 разом). Кожен прогін обробляє 20 000 задач на 50 тенантів без виконання кроків.
У режимі `job` цикл захоплює задачу й закриває її за токеном. У режимі `execution` він викликає
`CheckpointService.finish`, як воркер після останнього кроку. Після вимірювання тест перевіряє стан
усіх 20 000 задач, а в режимі `execution` — також стан і результат кожного виконання.
Кожен режим має п’ять пар прогонів на тій самій БД: FIFO і справедлива черга впритул, порядок у парі чергується. Так зміна швидкодії раннера протягом тесту зачіпає обидві половини пари однаково, а не всі прогони однієї версії.
Для FIFO відтворено послідовність операцій версії e2fadbf з відповідним обсягом запису.

Критерії відносні, бо абсолютні числа залежать від машини: раннер CI приблизно вдвічі повільніший
за ноутбук (у першому прогоні CI — 824–842 захоплень/с і p95 20–21,5 мс, тоді як локально 1771–1904/с
і ~10 мс). За медіаною відношень у п’яти парах:
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

## Аудит залежностей

Перевірено 20.11.2026 командою `npm audit --omit=dev` для обох production lock-файлів.

| Застосунок | До оновлення | Після оновлення |
|---|---|---|
| API | 20 пакетів із зауваженнями (8 high) | 13 moderate |
| Фронтенд | 3 пакети із зауваженнями (1 critical, 2 high) | 2 (1 critical, 1 high) |

Версії NestJS 10, Next.js 14, Node.js 20 та інші мажорні версії збережено. `overrides` оновлює сумісні транзитивні залежності в межах поточних major, зокрема `body-parser`, `multer`, `qs`, `lodash`, `js-yaml` і PostCSS. Nest завантажує `ws` 8.23.0 з кореня дерева замість вкладеної в адаптер версії 8.18.0. Стиснені тіла API й надалі відхиляються до розпакування.

| Залишкові зауваження | Як обмежено досяжність |
|---|---|
| NestJS: SSE та валідатори файлів | API використовує WebSocket. У застосунку немає SSE-маршрутів, multipart-завантажень і валідації файлів. |
| TypeORM: `glob`, `minimatch`; `uuid` | Міграції й сутності реєструються явними списками. Тенант не керує шаблонами файлової системи чи буферами UUID. |
| Next.js 14: Image Optimization, Windows, Server Actions, кеш і CSP | Підтримуваний runtime-образ Linux. Власний сервер відхиляє Image Optimization і методи запису за межами маршрутів API. Server Actions і rewrites відсутні. Production upgrade приймає тільки маршрут підписки з перевіркою Origin і тикета. Вхідні CSP/nonce та службові заголовки маршрутизації видаляються, nonce генерує сервер. Приватні відповіді мають `Cache-Control: private, no-store`, проксі формує заголовки відповіді за переліком. Автентифікацію й доступ до даних перевіряє API. |
| Zod 3: великі колекції | Схеми UI перевіряють чернетку з обмеженою кількістю кроків і заголовків. Публічний API перевіряє розмір і структуру незалежно від форми. |

Числа аудиту враховують версії пакетів і їхніх залежностей. Частина зауважень до Next.js 14 не має виправлення від розробника в цій мажорній версії. Публічний App Router має залишковий ризик, зокрема щодо відмови в обслуговуванні. Node.js 20 завершив цикл публічної підтримки. Захист на рівні застосунку зменшує досяжність окремих проблем. Для отримання повного набору виправлень розробників потрібні підтримувані гілки фреймворку й runtime.

[Бюлетень Next.js](https://vercel.com/changelog/next-js-may-2026-security-release) · [Бюлетень ws](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p) · [Статус випусків Node.js](https://nodejs.org/en/about/previous-releases)
