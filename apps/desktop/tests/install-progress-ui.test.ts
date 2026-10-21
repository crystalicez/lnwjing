import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GlobalInstallProgressModal } from '../src/renderer/features/shell/GlobalInstallProgressModal.js';

describe('GlobalInstallProgressModal', () => {
  it('renders determinate app-update progress with a blocking modal', () => {
    const markup = renderToStaticMarkup(createElement(GlobalInstallProgressModal, {
      locale: 'th',
      activity: {
        operations: [{
          kind: 'app_update',
          phase: 'downloading',
          progressPercent: 42,
          message: null,
          startedAt: '2026-09-21T10:00:00.000Z',
          updatedAt: '2026-09-21T10:00:01.000Z',
        }],
      },
    }));

    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('กำลังอัปเดต lnwjing');
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain('width:42%');
    expect(markup).not.toContain('is-indeterminate');
  });

  it('renders indeterminate progress for installers that do not expose byte progress', () => {
    const markup = renderToStaticMarkup(createElement(GlobalInstallProgressModal, {
      locale: 'en',
      activity: {
        operations: [{
          kind: 'ngrok',
          phase: 'installing',
          progressPercent: null,
          message: null,
          startedAt: '2026-09-21T10:00:00.000Z',
          updatedAt: '2026-09-21T10:00:00.000Z',
        }],
      },
    }));

    expect(markup).toContain('Installing ngrok');
    expect(markup).toContain('install-progress-bar is-indeterminate');
    expect(markup).not.toContain('aria-valuenow');
    expect(markup).toContain('Please wait');
  });
});
