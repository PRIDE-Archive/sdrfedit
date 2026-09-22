import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

/** Compact, keyboard-accessible disclosure shared by thinking and tool activity. */
@Component({
  selector: 'assistant-activity',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="activity" [class.failed]="failed()">
      <button type="button" class="head" (click)="open.set(!open())"
        [attr.aria-expanded]="open()" [attr.aria-label]="title() + (active() ? ' — running' : '') + ' — details'">
        <span class="title" [class.shimmer]="active()">{{ title() }}</span>
        @if (failed()) { <span class="state">Failed</span> }
        @if (meta()) { <span class="meta">{{ meta() }}</span> }
        <svg class="chevron" [class.open]="open()" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </button>
      <div class="details" [hidden]="!open()"><ng-content /></div>
    </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .head { display: flex; align-items: center; gap: 8px; max-width: 100%; min-height: 32px;
      border: 0; border-radius: 6px; padding: 5px 2px; background: transparent;
      color: #6b7280; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .head:hover { color: #374151; background: #f5f6f8; }
    .head:focus-visible { outline: 2px solid #818cf8; outline-offset: 3px; }
    .title { min-width: 0; overflow-wrap: anywhere; line-height: 1.6; }
    .shimmer { color: #737987; background: linear-gradient(110deg, #737987 20%, #a5a1c4 38%, #e1dff0 48%, #9185b6 58%, #737987 78%);
      background-size: 240% 100%; background-clip: text; -webkit-background-clip: text;
      -webkit-text-fill-color: transparent; animation: shimmer 2.2s linear infinite; }
    @keyframes shimmer { from { background-position: 180% 0; } to { background-position: -60% 0; } }
    .meta, .state { flex-shrink: 0; font-size: 11px; color: #9ca3af; }
    .failed .title, .state { color: #b91c1c; }
    .chevron { width: 14px; height: 14px; flex-shrink: 0; fill: none; stroke: currentColor;
      stroke-width: 1.5; transition: transform .15s ease; }
    .chevron.open { transform: rotate(90deg); }
    .details { margin: 5px 0 8px 2px; padding: 8px 0 8px 12px; border-left: 2px solid #e5e7eb; }
    .details[hidden] { display: none; }
    @media (prefers-reduced-motion: reduce) {
      .shimmer { animation: none; background: none; -webkit-text-fill-color: currentColor; }
      .chevron { transition: none; }
    }
    @media (forced-colors: active) {
      .shimmer { background: none; -webkit-text-fill-color: currentColor; }
    }
  `],
})
export class ActivityDisclosureComponent {
  readonly title = input.required<string>();
  readonly active = input(false);
  readonly failed = input(false);
  readonly meta = input('');
  readonly open = signal(false);
}
