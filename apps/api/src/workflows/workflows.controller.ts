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
import { TenantAuthGuard } from '../auth/api-key.guard';
import { RateLimit } from '../limits/rate-limit.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../entities';
import { ListWorkflowsQuery } from './dto/list-workflows.query';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow.dto';
import { workflowView } from './workflow-view';
import { WorkflowsService } from './workflows.service';

@Controller('workflows')
@RateLimit('tenant', { before: [TenantAuthGuard] })
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@CurrentTenant() t: Tenant, @Query() query: ListWorkflowsQuery) {
    return this.workflows.list(t.id, query);
  }

  @Get(':id')
  async get(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return workflowView(await this.workflows.get(t.id, id));
  }

  @Post()
  async create(@CurrentTenant() t: Tenant, @Body() body: CreateWorkflowDto) {
    return workflowView(await this.workflows.create(t.id, body));
  }

  @Patch(':id')
  async update(
    @CurrentTenant() t: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWorkflowDto,
  ) {
    return workflowView(await this.workflows.update(t.id, id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(t.id, id);
  }
}
