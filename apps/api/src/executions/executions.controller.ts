import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../entities';
import { WorkflowsService } from '../workflows/workflows.service';
import { ExecutionsService } from './executions.service';
import { parseIdempotencyKey } from './idempotency-key';
import { RunInputPipe } from './run-input.pipe';

@Controller()
@UseGuards(ApiKeyGuard)
export class ExecutionsController {
  constructor(
    private readonly executions: ExecutionsService,
    private readonly workflows: WorkflowsService,
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
    const workflow = await this.workflows.get(t.id, id);
    if (key === undefined)
      return this.executions.enqueue(workflow, input, 'api');
    const { execution, created } = await this.executions.enqueueOnce(
      workflow,
      input,
      key,
    );
    if (!created) res.status(200);
    return execution;
  }

  @Get('executions')
  list(@CurrentTenant() t: Tenant, @Query('limit') limit?: string) {
    return this.executions.list(t.id, limit ? Number(limit) : undefined);
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
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.executions.get(id);
  }
}
