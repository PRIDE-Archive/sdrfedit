/**
 * SDRF Editor App Component
 *
 * Main application component that hosts the SDRF editor.
 */

import { Component, OnInit, Input, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SdrfEditorComponent } from './components/sdrf-editor/sdrf-editor.component';

@Component({
  selector: 'sdrf-editor',
  standalone: true,
  imports: [FormsModule, SdrfEditorComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="app-container">
      <pride-header active-section="tools"></pride-header>
      <main class="app-main">
        <sdrf-editor-table
          [url]="activeUrl"
          [content]="activeContent"
          [exampleUrl]="exampleUrl"
          (tableChange)="onTableChange($event)"
          (validationComplete)="onValidation($event)"
          (loadUrlRequested)="onLoadUrlRequested($event)"
          (loadExampleRequested)="onLoadExampleRequested()"
        ></sdrf-editor-table>
      </main>
      <pride-footer></pride-footer>
    </div>
  `,
  styles: [`
    .app-container {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    .app-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: calc(100vh - 240px);
    }

    sdrf-editor-table {
      display: block;
      height: 100%;
    }
  `]
})
export class AppComponent implements OnInit {
  activeUrl = '';
  activeContent = '';

  // Example SDRF from bigbio/sdrf-annotated-datasets
  readonly exampleUrl = 'https://raw.githubusercontent.com/bigbio/sdrf-annotated-datasets/main/datasets/PXD000070/PXD000070.sdrf.tsv';

  ngOnInit(): void {
    // Check for URL parameter to auto-load SDRF file
    const urlParams = new URLSearchParams(window.location.search);
    const urlParam = urlParams.get('url');
    if (urlParam) {
      this.activeUrl = urlParam;
    }
    // Check for content parameter (base64-encoded TSV from Template Builder)
    const contentParam = urlParams.get('content');
    if (contentParam) {
      try {
        this.activeContent = atob(contentParam);
      } catch {
        console.error('Failed to decode content parameter');
      }
    }
  }

  onLoadUrlRequested(url: string): void {
    if (url) {
      this.activeUrl = url;
    }
  }

  onLoadExampleRequested(): void {
    this.activeUrl = this.exampleUrl;
  }

  onTableChange(table: unknown): void {
    console.log('Table changed:', table);
  }

  onValidation(result: unknown): void {
    console.log('Validation result:', result);
  }
}
