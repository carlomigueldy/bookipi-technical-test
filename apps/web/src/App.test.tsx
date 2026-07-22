import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { SERVICE_NAMES } from '@flash/shared';
import App from './App';

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ status: 'ok', service: 'api', version: '0.0.0', uptimeSeconds: 12 }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the service roster and the fetched API health payload', async () => {
    render(<App />);

    for (const name of SERVICE_NAMES) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }

    expect(await screen.findByText(/"status": "ok"/)).toBeInTheDocument();
  });
});
