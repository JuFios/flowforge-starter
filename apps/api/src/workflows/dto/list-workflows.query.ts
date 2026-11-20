import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { MAX_CURSOR_LENGTH, QueryInt } from '../../common/keyset-cursor';

/** Найбільша сторінка списку workflow: лише поля огляду, тож 100 рядків — малий обсяг. */
export const MAX_WORKFLOW_PAGE = 100;
export const DEFAULT_WORKFLOW_PAGE = 50;

/** Сторінка списку workflow: найновіші першими, курсор — з попередньої відповіді. */
export class ListWorkflowsQuery {
  @IsOptional()
  @QueryInt()
  @IsInt()
  @Min(1)
  @Max(MAX_WORKFLOW_PAGE)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(1, MAX_CURSOR_LENGTH)
  cursor?: string;
}
