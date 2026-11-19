import { EntityManager } from 'typeorm';
import { EffectiveLimits } from '../tenancy/limits';

/** Ефективні ліміти тенанта з контексту транзакції `em` (`tenant_limits()`). */
export async function effectiveLimits(
  em: EntityManager,
): Promise<EffectiveLimits> {
  const [row]: EffectiveLimits[] = await em.query(
    'SELECT * FROM tenant_limits()',
  );
  // Рядок є завжди, поки тенант існує (його читає той самий запит).
  if (!row) throw new Error('tenant limits are missing');
  return row;
}
