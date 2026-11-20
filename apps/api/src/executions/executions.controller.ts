import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  ParseIntPipe,
  BadRequestException,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { TenantAuthGuard } from '../auth/api-key.guard';
import { RateLimit } from '../limits/rate-limit.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../entities';
import { ExecutionReader } from './execution-reader.service';
import { ExecutionsService } from './executions.service';
import { parseIdempotencyKey } from './idempotency-key';
import { ListExecutionsQuery } from './list-executions.query';
import { RunInputPipe } from './run-input.pipe';

@Controller()
@RateLimit('tenant', { before: [TenantAuthGuard] })
export class ExecutionsController {
  constructor(
    private readonly reader: ExecutionReader,
    private readonly executions: ExecutionsService,
  ) {}

  /**
   * Запуск вручну. З заголовком `Idempotency-Key` повтор того самого запиту повертає вже створене
   * виконання (200), а не створює нове (201).
   */
  @Post('workflows/:id/run')
  async run(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(RunInputPipe) input: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key =
      idempotencyKey === undefined
        ? undefined
        : parseIdempotencyKey(idempotencyKey);
    const { execution, created } = await this.executions.enqueue(
      { id, tenantId: t.id },
      input,
      key,
    );
    if (!created) res.status(200);
    return execution;
  }

  @Get('executions')
  list(@CurrentTenant() t: Tenant, @Query() query: ListExecutionsQuery) {
    return this.executions.list(t.id, query);
  }

  /** Повтор виконання, що завершилось failed: продовження з першого незавершеного кроку. */
  @Post('executions/:id/retry')
  @HttpCode(202)
  async retry(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const execution = await this.executions.retry(t.id, id);
    return { executionId: execution.id };
  }

  @Get('executions/:id')
  get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.reader.detail(t.id, id);
  }
  @Get('executions/:id/summary')
  summary(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.reader.summary(t.id, id);
  }
  @Get('executions/:id/steps/:index')
  step(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    if (index < 0 || index >= 50)
      throw new BadRequestException('stepIndex має бути від 0 до 49');
    return this.reader.step(t.id, id, index);
  }
  @Get('executions/:id/output')
  output(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.reader.output(t.id, id);
  }
}
