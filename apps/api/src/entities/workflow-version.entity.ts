import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { TENANT_ID_DEFAULT } from './tenant-column';
import type { StepDefinition } from './workflow.entity';

/**
 * Незмінний знімок кроків workflow. Нова версія з'являється при кожній зміні кроків, у тій самій
 * транзакції, що й зміна workflow. Виконання посилається на версію, зафіксовану під час старту,
 * тож подальші правки (і видалення) workflow його не зачіпають. Зовнішнього ключа на workflows
 * навмисно немає: видалення workflow не видаляє версій, на які посилаються виконання.
 */
@Entity('workflow_versions')
@Unique('UQ_workflow_versions_workflow_version', ['workflowId', 'version'])
// Ціль композитного FK з executions: виконання посилається лише на знімок свого тенанта.
@Unique('UQ_workflow_versions_id_tenant', ['id', 'tenantId'])
export class WorkflowVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  workflowId: string;

  @Column({ type: 'uuid', default: TENANT_ID_DEFAULT })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_workflow_versions_tenant',
  })
  tenant?: Tenant;

  @Column('int')
  version: number;

  @Column('jsonb')
  steps: StepDefinition[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
