// Deliberately defective starting point: input order breaks ties; scope is ignored.
export function rankResults(results) {
  return [...results].sort((a, b) => b.score - a.score);
}
