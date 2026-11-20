import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Observable } from 'rxjs';
import { findInexactNumber, inexactNumberMessage } from './json-numbers';

/** Результат перевірки сирого JSON-тіла, записаний у запит до розбору. */
const INEXACT_NUMBER = Symbol('inexactJsonNumber');

type Marked = IncomingMessage & {
  [INEXACT_NUMBER]?: { path: string } | { charset: string };
};

/**
 * JSON-тіла API — лише UTF-8 (RFC 8259, розд. 8.1), як і тіла webhook-ів. Перевірка мусить
 * бачити той самий текст, що й розбір: body-parser (iconv-lite) вгадує порядок байтів `utf-16`
 * без BOM, а TextDecoder — ні, тож для іншого кодування неточне число пройшло б непоміченим.
 */
const UTF8 = 'utf-8';

/**
 * `verify` для JSON-парсера Express: перевіряє сирі байти до розбору й лише позначає запит.
 * Відмову дає ExactJsonNumbersInterceptor — після guard-ів, тож неавтентифікований запит отримує
 * 401, а не пояснення про тіло (як і перевірка глибини в пайпі). Кидати тут не можна:
 * body-parser перетворює будь-яку помилку verify на 403.
 */
export function markInexactJsonNumbers(
  req: IncomingMessage,
  _res: unknown,
  body: Buffer,
  encoding: string,
): void {
  // body-parser передає мітку в нижньому регістрі; без charset — 'utf-8'.
  if (encoding.toLowerCase() !== UTF8) {
    (req as Marked)[INEXACT_NUMBER] = { charset: encoding };
    return;
  }
  // Без `fatal`: некоректні байти body-parser так само замінює на U+FFFD.
  const path = findInexactNumber(new TextDecoder('utf-8').decode(body));
  if (path) (req as Marked)[INEXACT_NUMBER] = { path };
}

/** 400 для тіла з числом, яке змінилося б до збереження; 415 — для JSON не в UTF-8. */
@Injectable()
export class ExactJsonNumbersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const mark = context.switchToHttp().getRequest<Marked>()[INEXACT_NUMBER];
      if (mark && 'path' in mark)
        throw new BadRequestException(inexactNumberMessage(mark.path));
      if (mark)
        throw new UnsupportedMediaTypeException(
          'JSON-тіло має бути в кодуванні UTF-8',
        );
    }
    return next.handle();
  }
}
