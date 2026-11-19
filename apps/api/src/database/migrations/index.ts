import { InitialSchema1794920217603 } from './1794920217603-InitialSchema';
import { AddCorrelationId1794920232623 } from './1794920232623-AddCorrelationId';
import { TimestampsWithTimeZone1794920300000 } from './1794920300000-TimestampsWithTimeZone';
import { QueueLease1794949287178 } from './1794949287178-QueueLease';
import { StepCheckpoints1794949553919 } from './1794949553919-StepCheckpoints';
import { WorkflowVersions1794949818904 } from './1794949818904-WorkflowVersions';
import { DurableTimers1794950256356 } from './1794950256356-DurableTimers';
import { StepIdempotencyKey1794950965096 } from './1794950965096-StepIdempotencyKey';
import { JobFinishedAt1794989523846 } from './1794989523846-JobFinishedAt';
import { RunIdempotencyKey1794993774584 } from './1794993774584-RunIdempotencyKey';
import { HistoryIndexes1794993930872 } from './1794993930872-HistoryIndexes';
import { RecoverCheckpoints1795000000000 } from './1795000000000-RecoverCheckpoints';
import { TenantIsolation1795100000000 } from './1795100000000-TenantIsolation';
import { TenantUsage1795200000000 } from './1795200000000-TenantUsage';

/**
 * Явний перелік міграцій у порядку застосування. Без glob-шаблонів, щоб однаково
 * працювати з dist (CLI, docker) і з ts-jest (інтеграційні тести).
 * Нову міграцію після `migration:generate` треба додати сюди.
 */
export const MIGRATIONS = [
  InitialSchema1794920217603,
  AddCorrelationId1794920232623,
  TimestampsWithTimeZone1794920300000,
  QueueLease1794949287178,
  StepCheckpoints1794949553919,
  WorkflowVersions1794949818904,
  DurableTimers1794950256356,
  StepIdempotencyKey1794950965096,
  JobFinishedAt1794989523846,
  RunIdempotencyKey1794993774584,
  HistoryIndexes1794993930872,
  RecoverCheckpoints1795000000000,
  TenantIsolation1795100000000,
  TenantUsage1795200000000,
];
