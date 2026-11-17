import { InitialSchema1794920217603 } from './1794920217603-InitialSchema';
import { AddCorrelationId1794920232623 } from './1794920232623-AddCorrelationId';

/**
 * Явний перелік міграцій у порядку застосування. Без glob-шаблонів, щоб однаково
 * працювати з dist (CLI, docker) і з ts-jest (інтеграційні тести).
 * Нову міграцію після `migration:generate` треба додати сюди.
 */
export const MIGRATIONS = [InitialSchema1794920217603, AddCorrelationId1794920232623];
