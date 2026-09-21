// Reference implementation for fixture validation only; never a model delivery.
export function createClient({ transport }) {
  return { async request(input, options = {}) {
    const request = typeof input === 'string' ? { ...options, path: input } : input;
    if (!request || typeof request.path !== 'string' || !request.path.trim()) throw new TypeError('path is required');
    const { path, method = 'GET', body } = request;
    const response = await transport({ path, method, body });
    if (response.status >= 400) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'HTTP_ERROR', status: response.status });
    return response.data;
  } };
}
