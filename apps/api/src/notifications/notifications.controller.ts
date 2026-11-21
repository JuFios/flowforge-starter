import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable, addAbortSignal } from 'node:stream';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { SigningSecretDto } from '../common/key-material';
import { Tenant } from '../entities';
import { RateLimit } from '../limits/rate-limit.guard';
import {
  AttemptPageQuery,
  ListEventsQuery,
  NotificationSettingsDto,
} from './notifications.dto';
import { NotificationsService } from './notifications.service';

/** Налаштування сповіщень тенанта і журнал його подій (README 3.3.9). */
@Controller('tenants/me/notifications')
@RateLimit('tenant', { before: [ApiKeyGuard] })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  get(@CurrentTenant() tenant: Tenant) {
    return this.notifications.get(tenant.id);
  }

  /** Перше налаштування приймає секрет підпису тенанта; відповідь секрету не містить. */
  @Put()
  @Header('Cache-Control', 'no-store')
  put(@CurrentTenant() tenant: Tenant, @Body() body: NotificationSettingsDto) {
    return this.notifications.put(tenant.id, body);
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentTenant() tenant: Tenant): Promise<void> {
    await this.notifications.remove(tenant.id);
  }

  /** Новий ключ `next` із секретом тенанта (201); повтор того самого секрету — 200 з тим самим ID. */
  @Post('secrets')
  @Header('Cache-Control', 'no-store')
  async rotate(
    @CurrentTenant() tenant: Tenant,
    @Body() body: SigningSecretDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { id, role, created } = await this.notifications.rotate(
      tenant.id,
      body.secret,
    );
    if (!created) res.status(200);
    return { id, role };
  }

  @Delete('secrets/:keyId')
  @HttpCode(204)
  async revoke(
    @CurrentTenant() tenant: Tenant,
    @Param('keyId', ParseUUIDPipe) keyId: string,
  ): Promise<void> {
    await this.notifications.revoke(tenant.id, keyId);
  }

  @Get('events')
  list(@CurrentTenant() tenant: Tenant, @Query() query: ListEventsQuery) {
    return this.notifications.listEvents(tenant.id, query);
  }

  @Get('events/:id')
  async event(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AttemptPageQuery,
  ) {
    const paged = query.limit !== undefined || query.cursor !== undefined;
    const limit = query.limit ?? (paged ? 50 : 100);
    const read = (cursor?: string) =>
      this.notifications.eventPage(tenant.id, id, limit, cursor);
    const { attempts, nextAttemptsCursor, ...event } = await read(query.cursor);
    if (paged) return { ...event, attempts, nextAttemptsCursor };
    if (!nextAttemptsCursor) return { ...event, attempts };
    // Старий клієнт отримує той самий JSON. З’єднання з БД вільне під час очікування клієнта.
    async function* json() {
      yield JSON.stringify(event).slice(0, -1) + ',"attempts":[';
      yield JSON.stringify(attempts).slice(1, -1);
      let cursor = nextAttemptsCursor;
      while (cursor) {
        const page = await read(cursor);
        yield ',' + JSON.stringify(page.attempts).slice(1, -1);
        cursor = page.nextAttemptsCursor;
      }
      yield ']}';
    }
    const stream = addAbortSignal(
      AbortSignal.timeout(60_000),
      Readable.from(json(), { objectMode: false }),
    );
    return new StreamableFile(stream, {
      type: 'application/json; charset=utf-8',
    });
  }

  /** Явна відмова від недоставлених подій, створених до запиту (`pending` → `cancelled`). */
  @Post('events/discard')
  @HttpCode(200)
  discard(@CurrentTenant() tenant: Tenant) {
    return this.notifications.discard(tenant.id);
  }

  @Post('events/:id/redeliver')
  @HttpCode(202)
  redeliver(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.redeliver(tenant.id, id);
  }
}
