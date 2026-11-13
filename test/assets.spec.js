import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('dashboard and API routing', () => {
  it('serves the dashboard at the root', async () => {
    const response=await env.ASSETS.fetch('https://example.com/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html=await response.text();
    expect(html).toContain('SvitloRadar');
    expect(html).toContain('src="/app.js"');
  });
  it('serves the frontend modules', async () => {
    for (const path of ['/app.js','/schedule.js']) {
      const response=await env.ASSETS.fetch('https://example.com'+path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('javascript');
    }
  });
  it('keeps invalid and unknown API requests as JSON errors', async () => {
    for (const [path,status] of [['/api/schedule?group=13',400],['/api/missing',404]]) {
      const response=await SELF.fetch('https://example.com'+path);
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toHaveProperty('error');
    }
  });
});
