/**
 * SDRF Editor App Component
 *
 * Main application component that hosts the SDRF editor.
 */

import { Component, OnInit, Input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SdrfEditorComponent } from './components/sdrf-editor/sdrf-editor.component';

@Component({
  selector: 'sdrf-editor',
  standalone: true,
  imports: [FormsModule, SdrfEditorComponent],
  template: `
    <div class="app-container">
      <header class="pride-masthead">
        <div class="masthead-row">
          <a class="pride-brand" href="https://www.ebi.ac.uk/pride/archive/" title="PRIDE Archive">
            <img src="https://www.ebi.ac.uk/pride/logo/PRIDE_logo_Archive.png" alt="PRIDE" class="pride-brand-logo">
            <span class="pride-brand-name">SDRF Editor</span>
          </a>
        </div>
      </header>
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
    </div>
  `,
  styles: [`
    /* Design tokens follow the PRIDE web application (PRIDE-Archive/pride-web):
       teal primary #5bc0be, slate text #2f3644/#17233d, #f5f7f8 chrome. */
    .app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    .pride-masthead {
      flex-shrink: 0;
      background-color: #f5f7f8;
      border-bottom: 1px solid #e3e6ea;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
    }

    .masthead-row {
      max-width: 1600px;
      margin: 0 auto;
      padding: 10px 24px;
      display: flex;
      align-items: center;
    }

    .pride-brand {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      text-decoration: none;
      color: #17233d;
    }

    .pride-brand-logo {
      height: 36px;
      width: auto;
      display: block;
    }

    .pride-brand-name {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -.01em;
      padding-left: 14px;
      border-left: 1px solid #dcdee2;
    }

    .app-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
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
