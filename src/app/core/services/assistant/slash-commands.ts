/**
 * Slash commands the wizard assistant understands.
 *
 * Parsing here is for the UI chip and the structured `skill` / `skillArgs`
 * fields. The raw `/sdrf-annotate PXD…` line is sent as the user message;
 * the backend expands it and loads `sdrf_annotate.md`.
 */

export interface SlashCommand {
  name: string;
  args: string;
  accession: string | null;
  /** Text shown in the transcript chip. */
  label: string;
}

const SLASH_RE = /^\/(sdrf-annotate|sdrf:annotate)(?:\s+(.+))?\s*$/i;
const PXD_RE = /\b(PXD\d+)\b/i;

/** Parse a known slash command, or null if the text is ordinary chat. */
export function parseSlashCommand(text: string): SlashCommand | null {
  const match = SLASH_RE.exec(text.trim());
  if (!match) return null;

  const name = match[1].toLowerCase().replace(':', '-');
  const args = (match[2] || '').trim();
  const accessionMatch = PXD_RE.exec(args);
  const accession = accessionMatch ? accessionMatch[1].toUpperCase() : null;

  if (name !== 'sdrf-annotate') return null;

  return {
    name: 'sdrf-annotate',
    args,
    accession,
    label: accession ? `/sdrf-annotate ${accession}` : '/sdrf-annotate',
  };
}

/** Known commands shown when the user types `/` in the composer. */
export const SLASH_COMMAND_HINTS = [
  {
    command: '/sdrf-annotate',
    hint: 'Annotate a PXD dataset into this wizard',
    example: '/sdrf-annotate PXD000547',
  },
] as const;
