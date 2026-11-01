/** Quote one argument for a POSIX shell. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
