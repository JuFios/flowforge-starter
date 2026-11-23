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
import { TenantLimits1795300000000 } from './1795300000000-TenantLimits';

import { TenantQuotaConsistency1795400000000 } from './1795400000000-TenantQuotaConsistency';

import { ScheduledTenants1795500000000 } from './1795500000000-ScheduledTenants';

import { ScheduledOccurrences1795600000000 } from './1795600000000-ScheduledOccurrences';

import { JobUsageTransitions1795700000000 } from './1795700000000-JobUsageTransitions';
import { FairPromotion1795800000000 } from './1795800000000-FairPromotion';
import { ClaimBusyReport1795900000000 } from './1795900000000-ClaimBusyReport';
import { RateLimitLockTime1795910000000 } from './1795910000000-RateLimitLockTime';

/**
 * Явний перелік міграцій у порядку застосування. Без glob-шаблонів, щоб однаково
 * працювати з dist (CLI, docker) і з ts-jest (інтеграційні тести).
 * Нову міграцію після `migration:generate` треба додати сюди.
 */
import { RateLimitInsertTime1795920000000 } from './1795920000000-RateLimitInsertTime';

import { WebhookDeliveries1796000000000 } from './1796000000000-WebhookDeliveries';
import { ScheduleProgress1796100000000 } from './1796100000000-ScheduleProgress';
import { NotificationOutbox1796200000000 } from './1796200000000-NotificationOutbox';

import { SerializeOutbox1796300000000 } from './1796300000000-SerializeOutbox';

import { WorkflowQuota1796500000000 } from './1796500000000-WorkflowQuota';
import { CloseCancelledAttempts1796400000000 } from './1796400000000-CloseCancelledAttempts';

import { ExecutionPages1796600000000 } from './1796600000000-ExecutionPages';

import { BrowserSessions1796700000000 } from './1796700000000-BrowserSessions';

import { ExecutionRevision1796800000000 } from './1796800000000-ExecutionRevision';
import { WorkflowEditRevision1796900000000 } from './1796900000000-WorkflowEditRevision';
import { OutboxPause1797000000000 } from './1797000000000-OutboxPause';
import { OutboxQuota1797100000000 } from './1797100000000-OutboxQuota';
import { WorkflowVersionCleanup1797200000000 } from './1797200000000-WorkflowVersionCleanup';
import { WorkflowVersionCleanupPace1797300000000 } from './1797300000000-WorkflowVersionCleanupPace';

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
  TenantLimits1795300000000,
  TenantQuotaConsistency1795400000000,
  ScheduledTenants1795500000000,
  ScheduledOccurrences1795600000000,
  JobUsageTransitions1795700000000,
  FairPromotion1795800000000,
  ClaimBusyReport1795900000000,
  RateLimitLockTime1795910000000,
  RateLimitInsertTime1795920000000,
  WebhookDeliveries1796000000000,
  ScheduleProgress1796100000000,
  NotificationOutbox1796200000000,
  SerializeOutbox1796300000000,
  CloseCancelledAttempts1796400000000,
  WorkflowQuota1796500000000,
  ExecutionPages1796600000000,
  BrowserSessions1796700000000,
  ExecutionRevision1796800000000,
  WorkflowEditRevision1796900000000,
  OutboxPause1797000000000,
  OutboxQuota1797100000000,
  WorkflowVersionCleanup1797200000000,
  WorkflowVersionCleanupPace1797300000000,
];
