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
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../entities';
import { RateLimit } from '../limits/rate-limit.guard';
import { ListEventsQuery, NotificationSettingsDto } from './notifications.dto';
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

  /** Перше налаштування відповідає й секретом підпису — єдиний раз. */
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

  @Post('secrets')
  @Header('Cache-Control', 'no-store')
  rotate(@CurrentTenant() tenant: Tenant) {
    return this.notifications.rotate(tenant.id);
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
  event(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.getEvent(tenant.id, id);
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
