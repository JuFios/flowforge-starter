import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { TENANT_ID_DEFAULT } from './tenant-column';

export type StepDefinition =
  | {
      id: string;
      type: 'http';
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  | { id: string; type: 'transform'; expr: string }
  | { id: string; type: 'log'; message: string }
  | { id: string; type: 'delay'; ms: number };

@Entity('workflows')
@Index(['tenantId'])
@Index('IDX_workflows_scheduled_tenant', { synchronize: false })
export class Workflow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', default: TENANT_ID_DEFAULT })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_workflows_tenant',
  })
  tenant?: Tenant;

  @Column()
  name: string;

  @Column('jsonb')
  steps: StepDefinition[];

  @Column({ default: true })
  enabled: boolean;

  /** 5- або 6-польний cron; null — без розкладу. */
  @Column({ type: 'varchar', nullable: true })
  cron: string | null;

  @Column({ default: 'UTC' })
  timezone: string;

  @Column({ default: 1 })
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
