# Wizard Mobile & AI Assistant Implementation Notes

## Goals

This change addresses two problems:

1. On narrow phone screens, the creation wizard and the AI assistant no longer cramp each other in the desktop two-column layout.
2. The AI assistant can't bypass the wizard's required-field validation to skip ahead to later steps.

## Responsive Behavior

- At `1024px` and above, the existing desktop two-column layout is kept: wizard on the left, AI assistant on the right, with a draggable divider to resize the assistant panel.
- Below `1024px`, a single-page mode is used, covering phones and common portrait tablets:
  - The wizard fills the viewport, and is shown by default on first open.
  - After clicking `Ask AI`, the AI assistant fills the viewport and temporarily hides the wizard.
  - Clicking the close button in the assistant's top-right corner returns to the wizard; both the chat and form state are preserved.
  - The assistant's left-side drag handle is hidden, and the panel width saved from desktop is ignored.
- Narrow screens use `100dvh` for height, to accommodate mobile browsers' dynamic address bar; the content area and bottom navigation reduce their padding accordingly.
- The top step bar remains horizontally scrollable, preserving full step names and the ability to go back to previously visited steps.

## Navigation Constraints

The `nextStep` returned by the AI is only a navigation suggestion; the frontend must independently judge it:

- When the target is the immediately next step, forward navigation is only allowed if the current step's `canProceed()` is true.
- Navigation is allowed when the target is the current step or a step already visited.
- Navigation is rejected when it spans multiple steps, is out of bounds, or the current step is incomplete.

When navigation is rejected, no automatic follow-up request is sent for the next page, to avoid the chat content getting out of sync with the actual form page.

## Draft Safety

- Clicking the overlay no longer closes the wizard directly, to avoid accidentally clearing the draft from a stray scroll or tap on mobile.
- Explicitly clicking the wizard's close button is still treated as abandoning the current draft, and keeps the original cleanup logic.
- Closing the AI assistant only hides the panel; it does not clear the chat or wizard state.

## Test Coverage

- Pure function tests cover: normal progression, validation failure, going back, skipping steps, and out-of-bounds targets.
- An Angular production build is used to check component templates, styles, and TypeScript integration.
- Manual acceptance testing is recommended at `390x844`, `768x1024`, and common desktop widths.

## Server Deployment

Nginx serves the frontend files directly from `/www/wwwroot/www.sdrf.site`, and proxies `/api/`
to the local AI service. After new `dist/**` files are committed, `deploy-frontend.yml` connects
to the server via SSH; the repository is only updated when the working tree has no tracked
changes and can fast-forward, after which `scripts/deploy-frontend.sh` runs. The script copies
the build artifacts and then checks the homepage and `/api/health`.

The dist-only commits produced by `build-dist.yml` no longer include `[skip ci]`, so they also
trigger the deployment flow above; that workflow itself doesn't watch `dist/**`, so it doesn't
create a recursive build loop.
