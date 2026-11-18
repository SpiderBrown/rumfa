type Q = (sql: string, params?: unknown[]) => Promise<any[]>;

/** Records something Rumfa staff did (who, what, on which client or item). Never updated or deleted. */
export async function audit(q: Q, who: { sid: string } | null, action: string, targetType?: string, targetId?: string | null,
                            details: Record<string, unknown> = {}, tenantId?: string | null) {
  await q(
    `insert into public.platform_audit (staff_id, action, target_type, target_id, tenant_id, details) values ($1, $2, $3, $4, $5, $6)`,
    [who?.sid ?? null, action, targetType ?? null, targetId ?? null, tenantId ?? null, JSON.stringify(details)]);
}
