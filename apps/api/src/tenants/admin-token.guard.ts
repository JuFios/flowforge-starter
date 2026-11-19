import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { safeEqual } from '../common/safe-equal';
import { EnvironmentVariables } from '../config/env.validation';

/** Службові ендпоінти `/tenants…`: заголовок `x-admin-token` дорівнює ADMIN_TOKEN, інакше 403. */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const token = ctx.switchToHttp().getRequest<Request>().headers[
      'x-admin-token'
    ];
    const expected = this.config.get('ADMIN_TOKEN', { infer: true });
    if (!expected || !safeEqual(token, expected))
      throw new ForbiddenException();
    return true;
  }
}
