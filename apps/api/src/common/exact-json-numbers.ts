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
  [INEXACT_NUMBER]?:
    { path: string } | { charset: string } | { invalidUtf8: true };
};

/**
 * JSON-тіла API — лише валідний UTF-8 (RFC 8259, розд. 8.1), як і тіла webhook-ів. Перевіряється
 * і мітка, і самі байти. Мітка — бо body-parser (iconv-lite) вгадує порядок байтів `utf-16` без
 * BOM, а TextDecoder — ні, тож перевірка бачила б не той текст, що розбір. Байти — бо body-parser
 * мовчки замінює невалідні послідовності на U+FFFD, і обробник отримав би інші дані.
 */
const UTF8 = 'utf-8';
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

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
  let text: string;
  try {
    text = STRICT_UTF8.decode(body);
  } catch {
    (req as Marked)[INEXACT_NUMBER] = { invalidUtf8: true };
    return;
  }
  const path = findInexactNumber(text);
  if (path) (req as Marked)[INEXACT_NUMBER] = { path };
}

/**
 * Після guard-ів: 400 для невалідних байтів UTF-8 і для числа, яке змінилося б до збереження;
 * 415 — для JSON з іншою міткою кодування.
 */
@Injectable()
export class ExactJsonNumbersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const mark = context.switchToHttp().getRequest<Marked>()[INEXACT_NUMBER];
      if (mark && 'path' in mark)
        throw new BadRequestException(inexactNumberMessage(mark.path));
      // Те саме повідомлення, що й для webhook-а з тими самими байтами.
      if (mark && 'invalidUtf8' in mark)
        throw new BadRequestException('Невалідний UTF-8 JSON');
      if (mark)
        throw new UnsupportedMediaTypeException(
          'JSON-тіло має бути в кодуванні UTF-8',
        );
    }
    return next.handle();
  }
}
