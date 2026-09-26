/** Parse a pasted list; double quotes preserve separators inside file names. */
export function parseFileNameList(text: string): string[] {
  const names: string[] = [];
  let token = '';
  let quoted = false;
  const flush = () => { if (token) names.push(token); token = ''; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { token += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && /[\s,;，；]/.test(char)) {
      flush();
    } else token += char;
  }
  flush();
  return [...new Set(names)];
}
