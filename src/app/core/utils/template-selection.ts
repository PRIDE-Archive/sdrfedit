import type { TemplateSelection } from '../models/template';

/** One-time migration for old drafts; canonical selections always take precedence. */
export function selectedTemplateIds(selection: TemplateSelection): string[] {
  return [...new Set(selection.selectedTemplates !== undefined
    ? selection.selectedTemplates.map(ref => ref.name)
    : [selection.technologyTemplate, selection.sampleTemplate,
       ...(selection.sampleMetadataTemplates || []), ...selection.experimentTemplates]
      .filter((name): name is string => !!name))];
}
