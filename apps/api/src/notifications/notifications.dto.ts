import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { IsStorableText } from '../common/storable-text';
import { MAX_URL_LENGTH } from '../workflows/definition';

/** Налаштування сповіщень тенанта (README 3.3.9, «Налаштування»). */
export class NotificationSettingsDto {
  /** Endpoint отримувача: `https:`, без облікових даних, лише публічні адреси. */
  @IsString()
  @IsStorableText()
  @Length(1, MAX_URL_LENGTH)
  url: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export const EVENT_STATUSES = [
  'pending',
  'sending',
  'delivered',
  'cancelled',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Сторінка подій: найновіші першими, курсор — з відповіді попередньої сторінки. */
export class AttemptPageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;
}

export class ListEventsQuery extends AttemptPageQuery {
  @IsOptional()
  @IsIn(EVENT_STATUSES)
  status?: EventStatus;
}
