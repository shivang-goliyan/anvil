// A capability that only reads, on the project's own demo site, so a page redesign can be shown on it.
// The plan below is hand-written. Every later version of it is derived.

import { capId, sandboxHost } from '../src/tenants.mjs';

export function harborEvents(sandbox = '') {
  // the public read-only view where there is one (production; a sandbox's copy sits under /t/<id>/),
  // otherwise the made-up origin answered locally
  const pub = process.env.DEMO_PUBLIC_URL?.replace(/\/$/, '');
  const base = pub ? `${pub}${sandbox ? `/t/${sandbox}` : ''}` : `https://${sandboxHost(sandbox)}`;
  const targetUrl = `${base}/events`;
  return {
    id: capId('harbor-events', sandbox),
    name: "Read the library's upcoming events",
    goal: "the library's upcoming events, each with its title, date, start time, room and the number of seats left",
    engine: 'scrape',
    targetUrl,
    inputSchema: {},
    canary: '.site-header',
    steps: [
      { kind: 'navigate', url: targetUrl },
      { kind: 'assert', selector: 'ul.events' },
      {
        kind: 'extract',
        each: 'li.event',
        fields: {
          title: { selector: '.event-title', type: 'string' },
          date: { selector: '.event-date', type: 'string' },
          time: { selector: '.event-time', type: 'string' },
          room: { selector: '.event-room', type: 'string' },
          seats_left: { selector: '.seats-left', type: 'number' },
        },
      },
    ],
  };
}
