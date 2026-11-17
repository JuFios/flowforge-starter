import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { StepDefinition } from './workflow.entity';

/**
 * Незмінний знімок кроків workflow. Нова версія з'являється при кожній зміні кроків, у тій самій
 * транзакції, що й зміна workflow. Виконання посилається на версію, зафіксовану під час старту,
 * тож подальші правки (і видалення) workflow його не зачіпають. Зовнішнього ключа на workflows
 * навмисно немає: видалення workflow не видаляє версій, на які посилаються виконання.
 */
@Entity('workflow_versions')
@Unique('UQ_workflow_versions_workflow_version', ['workflowId', 'version'])
export class WorkflowVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  workflowId: string;

  @Column('uuid')
  tenantId: string;

  @Column('int')
  version: number;

  @Column('jsonb')
  steps: StepDefinition[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
