// Deliberately defective starting point: one bad row aborts the whole batch.
export function importTickets(rows) {
  return { imported: rows.map(row => {
    if (!row.id || !row.title) throw new Error('Invalid ticket');
    return { id: row.id, title: row.title };
  }), errors: [] };
}
