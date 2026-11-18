import {
  IsBoolean,
  IsDefined,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { IsStorableText } from '../../common/storable-text';

export const MAX_WORKFLOW_NAME_LENGTH = 200;
/** Довжина рядків cron і таймзони; сенс виразу й IANA-зони перевіряє планувальник. */
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
}

/** Часткова зміна workflow: ті самі правила, усі поля необов'язкові. */
export class UpdateWorkflowDto {
  @IsOptional()
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

  @IsOptional()
  @IsString()
  @IsStorableText()
  @Length(1, MAX_TIMEZONE_LENGTH)
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
