export function mapFileName(id: number): string {
  return `Map${String(id).padStart(3, '0')}.json`;
}
