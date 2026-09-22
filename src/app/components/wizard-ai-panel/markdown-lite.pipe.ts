import { Pipe, PipeTransform } from '@angular/core';
import { renderMarkdownLite } from './markdown-lite';

/** Each binding only reparses when its own text changes. */
@Pipe({ name: 'assistantMarkdown', standalone: true, pure: true })
export class MarkdownLitePipe implements PipeTransform {
  transform(text: string): string { return renderMarkdownLite(text); }
}
