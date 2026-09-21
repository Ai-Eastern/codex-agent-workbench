// Deliberately defective starting point: only the new object call works.
export function createClient({ transport }) {
  return { async request({ path, method = 'GET', body }) {
    const response = await transport({ path, method, body });
    return response.data;
  } };
}
