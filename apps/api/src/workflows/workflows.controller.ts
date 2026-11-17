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
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../entities';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow.dto';
import { WorkflowsService } from './workflows.service';

@Controller('workflows')
@UseGuards(ApiKeyGuard)
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@CurrentTenant() t: Tenant) {
    return this.workflows.list(t.id);
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
