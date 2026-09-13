// Tier B capability against the project's own target site.
// The plan below is hand-written. Every later version of it is derived.

const FORWARD_ORIGIN = 'https://harbor-lane.anvil.test';

export function reserveRoom() {
  const forward = process.env.TARGET_URL ? null : process.env.TARGET_FORWARD || 'http://localhost:4310';
  return {
    id: 'reserve-room',
    name: 'Reserve a study room',
    goal:
      'Reserve a study room at Harbor Lane Library for the given patron, then read the confirmation screen and return the reservation reference together with the name, email and seat count it shows.',
    targetUrl: process.env.TARGET_URL || `${FORWARD_ORIGIN}/`,
    forward,
    inputSchema: { name: 'string', email: 'string', seats: 'number' },
    canary: '.site-header',
    status: 'healthy',
    plan: {
      version: 1,
      origin: 'hand-written',
      derivedFrom: null,
      steps: [
        { kind: 'navigate', url: '/' },
        { kind: 'fill', selector: 'input[name="full_name"]', value: '{{name}}' },
        { kind: 'fill', selector: 'input[name="email"]', value: '{{email}}' },
        { kind: 'fill', selector: 'input[name="seats"]', value: '{{seats}}' },
        { kind: 'submit', selector: '#reserve-form button[type="submit"]' },
        { kind: 'assert', selector: '#reference' },
        {
          kind: 'extract',
          fields: {
            reference: { selector: '#reference', type: 'string' },
            name: { selector: '.summary-name', type: 'string' },
            email: { selector: '.summary-email', type: 'string' },
            seats: { selector: '.summary-seats', type: 'number' },
          },
        },
      ],
    },
    planHistory: [],
    snapshot: null,
    contract: null,
    repairs: [],
  };
}
