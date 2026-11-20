import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { IsStorableText } from '../../common/storable-text';
import { MISSED_RUN_POLICIES, MissedRunPolicy } from '../../entities';

export const MAX_WORKFLOW_NAME_LENGTH = 200;
/** Довжина рядків cron і таймзони; сенс виразу й IANA-зону перевіряє WorkflowsService. */
export const MAX_CRON_LENGTH = 100;
export const MAX_TIMEZONE_LENGTH = 64;

/** Створення workflow. Кроки (`steps`) перевіряє validateSteps — їхня схема залежить від типу. */
export class CreateWorkflowDto {
  @IsString()
  @IsStorableText()
  @Length(1, MAX_WORKFLOW_NAME_LENGTH)
  name: string;

  @IsDefined()
  steps: unknown;

  @IsOptional()
  @IsString()
  @IsStorableText()
  @MaxLength(MAX_CRON_LENGTH)
  cron?: string | null;

  @IsOptional()
  @IsString()
  @IsStorableText()
  @Length(1, MAX_TIMEZONE_LENGTH)
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(MISSED_RUN_POLICIES)
  missedRunPolicy?: MissedRunPolicy;
}

/** Часткова зміна workflow: ті самі правила, усі поля необов'язкові. */
export class UpdateWorkflowDto {
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}$/)
  editRevision?: string;

  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsString()
  @IsStorableText()
  @Length(1, MAX_WORKFLOW_NAME_LENGTH)
  name?: string;

  @IsOptional()
  steps?: unknown;

  @IsOptional()
  @IsString()
  @IsStorableText()
  @MaxLength(MAX_CRON_LENGTH)
  cron?: string | null;

  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsString()
  @IsStorableText()
  @Length(1, MAX_TIMEZONE_LENGTH)
  timezone?: string;

  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;

  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsIn(MISSED_RUN_POLICIES)
  missedRunPolicy?: MissedRunPolicy;
}
