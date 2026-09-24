import type { TemplateInfo } from '../models/template';
import { isDevelopmentTemplate } from '../models/template';

export interface TemplateBranch {
  key: string;
  parent: TemplateInfo | null;
  path: string[];
  templates: TemplateInfo[];
}
export interface TemplateHierarchyGroup {
  layer: string;
  roots: TemplateInfo[];
  branches: TemplateBranch[];
}
export interface TemplateHierarchy {
  groups: TemplateHierarchyGroup[];
  childCounts: Map<string, number>;
  childLayers: Map<string, string[]>;
}

/** Navigation only. Selection eligibility and version resolution remain on the backend. */
export function buildTemplateHierarchy(
  catalog: TemplateInfo[], selected: string[], includeDevelopment: boolean,
  allowedIds?: string[] | null,
): TemplateHierarchy {
  const all = new Map(catalog.map(template => [template.id, template]));
  const allowed = allowedIds?.length ? new Set(allowedIds) : null;
  const selectable = new Map(catalog.filter(t => t.layer && (!allowed || allowed.has(t.id))).map(t => [t.id, t]));
  const selectedSet = new Set(selected);
  const shown = new Set([...selectable.values()]
    .filter(t => includeDevelopment || !isDevelopmentTemplate(t) || selectedSet.has(t.id)).map(t => t.id));

  function ancestors(id: string): string[] {
    const result: string[] = [];
    const seen = new Set([id]);
    let parent = all.get(id)?.extends?.split('@')[0];
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      result.push(parent);
      parent = all.get(parent)?.extends?.split('@')[0];
    }
    return result;
  }
  // Preserve access to stable/selected children even if an ancestor is prerelease.
  for (const id of [...shown]) for (const ancestor of ancestors(id)) {
    if (selectable.has(ancestor)) shown.add(ancestor);
  }
  const parentOf = new Map<string, string>();
  const children = new Map<string, TemplateInfo[]>();
  for (const id of shown) {
    const parent = ancestors(id).find(ancestor => shown.has(ancestor));
    // Malformed cycles should not make cards disappear or recurse indefinitely.
    if (parent && !ancestors(parent).includes(id)) {
      parentOf.set(id, parent);
      children.set(parent, [...(children.get(parent) || []), selectable.get(id)!]);
    }
  }
  const expanded = new Set(selected);
  for (const id of selected) for (const ancestor of ancestors(id)) expanded.add(ancestor);
  const rootsByLayer = new Map<string, TemplateInfo[]>();
  for (const id of shown) {
    if (parentOf.has(id)) continue;
    const template = selectable.get(id)!;
    rootsByLayer.set(template.layer!, [...(rootsByLayer.get(template.layer!) || []), template]);
  }
  const layerOrder = ['technology', 'sample', 'experiment'];
  const rank = (layer: string) => { const i = layerOrder.indexOf(layer); return i < 0 ? layerOrder.length : i; };
  // Presentation preference only: common samples first, expandable categories last.
  // Unknown templates remain discoverable and their selection rules are unchanged.
  const commonSamples = ['human', 'vertebrates', 'plants', 'invertebrates'];
  const orderTemplates = (templates: TemplateInfo[]) => [...templates].sort((a, b) => {
    if (a.layer === 'sample' && b.layer === 'sample') {
      const expandable = Number(children.has(a.id)) - Number(children.has(b.id));
      if (expandable) return expandable;
      const preference = (id: string) => {
        const index = commonSamples.indexOf(id);
        return index < 0 ? commonSamples.length : index;
      };
      const preferred = preference(a.id) - preference(b.id);
      if (preferred) return preferred;
    }
    return a.name.localeCompare(b.name);
  });
  const byLayer = new Map<string, TemplateHierarchyGroup>();
  function groupFor(layer: string): TemplateHierarchyGroup {
    let group = byLayer.get(layer);
    if (!group) {
      group = { layer, roots: [], branches: [] };
      byLayer.set(layer, group);
    }
    return group;
  }
  for (const [layer, templates] of rootsByLayer) {
    const group = groupFor(layer);
    group.roots = orderTemplates(templates);
    group.branches.push({ key: layer, parent: null, path: [], templates: group.roots });
  }
  function appendBranches(templates: TemplateInfo[], path: string[]) {
    for (const template of templates) {
      const descendants = children.get(template.id);
      if (!expanded.has(template.id) || !descendants?.length || path.includes(template.id)) continue;
      const nextPath = [...path, template.id];
      const childGroups = new Map<string, TemplateInfo[]>();
      for (const child of descendants) {
        childGroups.set(child.layer!, [...(childGroups.get(child.layer!) || []), child]);
      }
      for (const [layer, nodes] of childGroups) {
        const ordered = orderTemplates(nodes);
        // Inheritance controls disclosure, but never moves a node out of its own layer.
        groupFor(layer).branches.push({ key: template.id, parent: template, path: nextPath, templates: ordered });
        appendBranches(ordered, nextPath);
      }
    }
  }
  for (const templates of rootsByLayer.values()) appendBranches(orderTemplates(templates), []);
  const groups = [...byLayer.values()].sort((a, b) => rank(a.layer) - rank(b.layer) || a.layer.localeCompare(b.layer));
  return { groups, childCounts: new Map([...children].map(([id, nodes]) => [id, nodes.length])),
    childLayers: new Map([...children].map(([id, nodes]) => [id, [...new Set(nodes.map(node => node.layer!))]])) };
}

export interface TemplateDisplaySection {
  key: string;
  refinements: boolean;
  templates: TemplateInfo[];
}

/** Combine revealed options across every active parent, without separate parent grids. */
export function templateDisplaySections(group: TemplateHierarchyGroup): TemplateDisplaySection[] {
  const unique = (templates: TemplateInfo[]) => [...new Map(templates.map(t => [t.id, t])).values()];
  const all = unique(group.branches.flatMap(branch => branch.templates));
  if (group.layer !== 'sample') return [{ key: group.layer, refinements: false, templates: all }];
  const roots = new Set(group.roots.map(t => t.id));
  const descendants = all.filter(t => !roots.has(t.id));
  return [
    ...(group.roots.length ? [{ key: 'sample', refinements: false, templates: group.roots }] : []),
    ...(descendants.length ? [{ key: 'sample-refinements', refinements: true, templates: descendants }] : []),
  ];
}
