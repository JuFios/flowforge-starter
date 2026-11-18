import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../config/env.validation';

/**
 * Адреса БД runtime-процесу (DATABASE_URL — його власна роль: API чи воркера). Окремий провайдер,
 * щоб інтеграційні тести, які запускають API і воркер в одному процесі, давали кожному свою роль.
 */
export const RUNTIME_DATABASE_URL = Symbol('RUNTIME_DATABASE_URL');

@Module({
  providers: [
    {
      provide: RUNTIME_DATABASE_URL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): string =>
        config.get<string>('DATABASE_URL'),
    },
  ],
  exports: [RUNTIME_DATABASE_URL],
})
export class RuntimeDatabaseUrlModule {}
