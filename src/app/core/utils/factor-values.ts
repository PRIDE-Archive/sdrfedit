/** Compare literal or NT/AC SDRF representations without treating distinct accessions as equal. */
export function equivalentFactorValue(left: string, right: string): boolean {
  const parse = (text: string) => {
    const fields = new Map(text.split(';').map(part => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim().toLowerCase()];
    }));
    return { accession: fields.get('ac'), name: fields.get('nt') || text.trim().toLowerCase() };
  };
  const a = parse(left), b = parse(right);
  return a.accession && b.accession ? a.accession === b.accession : a.name === b.name;
}
