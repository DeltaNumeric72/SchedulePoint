/**
 * RED CASE — lint.
 *
 * The banned spelling of tenant context. `SET LOCAL app.organization_id = ...`
 * cannot be parameterised, so writing it means interpolating the tenant id into
 * SQL: an injection surface at the single most security-critical statement in
 * the system (SPIKE-REPORT §7.2). ESLint's no-restricted-syntax rule must
 * reject this file.
 */
export function establishTenantContext(organizationId: string): string {
  return `SET LOCAL app.organization_id = '${organizationId}'`;
}
