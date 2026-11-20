import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { RateLimit } from '../limits/rate-limit.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../entities';
import { ListWorkflowsQuery } from './dto/list-workflows.query';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow.dto';
import { WorkflowsService } from './workflows.service';

@Controller('workflows')
@RateLimit('tenant', { before: [ApiKeyGuard] })
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@CurrentTenant() t: Tenant, @Query() query: ListWorkflowsQuery) {
    return this.workflows.list(t.id, query);
  }

  @Get(':id')
  get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.get(t.id, id);
  }

  @Post()
  create(@CurrentTenant() t: Tenant, @Body() body: CreateWorkflowDto) {
    return this.workflows.create(t.id, body);
  }

  @Patch(':id')
  update(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWorkflowDto,
  ) {
    return this.workflows.update(t.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(t.id, id);
  }
}
