/** Форми відповідей API, якими користується інтерфейс (OpenAPI: `/docs`). */
import type { MissedRunPolicy, StepType } from './workflow-schema';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  enabled: boolean;
  cron: string | null;
  timezone: string;
  version: number;
  missedRunPolicy: MissedRunPolicy;
  nextFireAt: string | null;
  scheduleBlockedSince: string | null;
  scheduleError: string | null;
  createdAt: string;
}

/** Збережене значення заголовка: саме значення API не повертає. */
export interface StoredHeader {
  stored: true;
}

export type StepView =
  | {
      id: string;
      type: 'http';
      url: string;
      method?: string;
      headers?: Record<string, StoredHeader>;
      body?: string;
    }
  | { id: string; type: 'transform'; expr: string; language?: 'jsonata-v1' }
  | { id: string; type: 'log'; message: string }
  | { id: string; type: 'delay'; ms: number };

export interface WorkflowView extends WorkflowSummary {
  steps: StepView[];
  scheduleCursor: string;
}

export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ExecutionListItem {
  id: string;
  workflowId: string;
  workflowName: string | null;
  workflowVersion: number | null;
  status: ExecutionStatus;
  trigger: 'api' | 'webhook' | 'cron';
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  scheduledAt: string | null;
  correlationId: string | null;
}

export interface StepSummary {
  stepIndex: number;
  stepId: string;
  status: 'running' | 'succeeded' | 'failed';
  attempts: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  wakeAt: string | null;
  outputBytes: number | null;
}

/** Знімок виконання: та сама форма в `GET /executions/:id/summary` і в повідомленні WebSocket. */
export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowName: string | null;
  workflowVersion: number | null;
  status: ExecutionStatus;
  trigger: 'api' | 'webhook' | 'cron';
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  scheduledAt: string | null;
  correlationId: string | null;
  /** Монотонна ревізія: більша — новіша (рядок, бо bigint). */
  revision: string;
  outputBytes: number | null;
  inputBytes: number;
  plan: Array<{ id: string; type: StepType }>;
  steps: StepSummary[];
}

export interface StepDetail extends StepSummary {
  output: unknown;
}

export interface ApiErrorBody {
  statusCode?: number;
  error?: string;
  message?: string | string[];
  correlationId?: string;
}
