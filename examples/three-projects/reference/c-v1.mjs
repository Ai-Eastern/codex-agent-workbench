// Reference implementation for fixture validation only; never a model delivery.
export function rankResults(results, { projectId } = {}) {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new TypeError('projectId is required');
  return results.filter(row => row.projectId === projectId).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
