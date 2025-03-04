import { expect, Request } from '@playwright/test';

import { sentryTest } from '../../../../../utils/fixtures';

sentryTest(
  '[pre-v8] should prefer custom tracePropagationTargets over tracingOrigins',
  async ({ getLocalTestPath, page }) => {
    const url = await getLocalTestPath({ testDir: __dirname });

    const requests = (
      await Promise.all([
        page.goto(url),
        Promise.all([0, 1, 2].map(idx => page.waitForRequest(`http://example.com/${idx}`))),
      ])
    )[1];

    expect(requests).toHaveLength(3);

    requests?.forEach(async (request: Request) => {
      const requestHeaders = await request.allHeaders();
      expect(requestHeaders).not.toMatchObject({
        'sentry-trace': expect.any(String),
        baggage: expect.any(String),
      });
    });
  },
);
