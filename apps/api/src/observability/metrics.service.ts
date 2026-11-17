import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Registry } from 'prom-client';

/**
 * Реєстр метрик процесу (API або воркера). Дефолтні метрики Node.js збираються одразу;
 * доменні метрики (черга, кроки, повтори) реєструються в цьому ж реєстрі.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
