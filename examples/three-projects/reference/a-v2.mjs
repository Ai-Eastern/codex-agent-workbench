// Reference implementation for fixture validation only; never a model delivery.
export function importTickets(rows, { tenantId, existing = [] } = {}) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) throw new TypeError('tenantId is required');
  const imported = [], errors = [];
  const seen = new Set(existing.filter(row => row.tenantId === tenantId).map(row => row.id));
  rows.forEach((row, index) => {
    let code;
    if (!row || typeof row !== 'object' || Array.isArray(row)) code = 'INVALID_ROW';
    else if (typeof row.tenantId !== 'string' || !row.tenantId.trim()) code = 'TENANT_REQUIRED';
    else if (row.tenantId !== tenantId) code = 'TENANT_MISMATCH';
    else if (typeof row.id !== 'string' || !row.id.trim()) code = 'ID_REQUIRED';
    else if (typeof row.title !== 'string' || !row.title.trim()) code = 'TITLE_REQUIRED';
    else if (seen.has(row.id)) code = 'DUPLICATE_ID';
    if (code) errors.push({ row: index + 1, code });
    else { seen.add(row.id); imported.push({ id: row.id, title: row.title, tenantId }); }
  });
  return { imported, errors };
}
