import {
  Controller,
  Delete,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiKeyGuard,
  TenantAuthGuard,
  TenantRequest,
} from '../auth/api-key.guard';
import { RateLimit } from '../limits/rate-limit.guard';
import { SessionsService } from './sessions.service';

@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}
  @Post('sessions')
  @Header('Cache-Control', 'no-store')
  @RateLimit('tenant', { before: [ApiKeyGuard] })
  create(@Req() req: TenantRequest) {
    return this.sessions.create(req.tenant.id);
  }

  @Delete('sessions/current')
  @HttpCode(204)
  @RateLimit('session_revoke', { before: [TenantAuthGuard] })
  revoke(@Req() req: TenantRequest) {
    return this.sessions.revoke(req.tenant.id, req.sessionId);
  }

  @Post('executions/:id/realtime-tickets')
  @Header('Cache-Control', 'no-store')
  @RateLimit('tenant', { before: [TenantAuthGuard] })
  ticket(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.ticket(req.tenant.id, id, req.sessionId);
  }
}
