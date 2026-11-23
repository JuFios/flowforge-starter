import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { MAX_CURSOR_LENGTH, QueryInt } from '../common/keyset-cursor';
import { ExecutionStatus } from '../entities/execution.entity';

/** Статуси фільтра списку виконань. */
export const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
];

export class ListExecutionsQuery {
  @IsOptional()
  @QueryInt()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsIn(EXECUTION_STATUSES)
  status?: ExecutionStatus;

  @IsOptional()
  @IsUUID()
  workflowId?: string;

  @IsOptional()
  @IsString()
  @Length(1, MAX_CURSOR_LENGTH)
  cursor?: string;
}
