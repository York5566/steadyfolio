import Papa from 'papaparse';

export function csvText(rows: (string | number | null)[][]): string {
  const safeRows = rows.map(row => row.map(cell => typeof cell === 'string' && /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell));
  return '\uFEFF' + Papa.unparse(safeRows);
}
