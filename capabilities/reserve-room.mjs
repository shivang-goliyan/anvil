// Tier B capability against the project's own target site.
// The plan below is hand-written. Every later version of it is derived.

export function reserveRoom() {
  return {
    id: 'reserve-room',
    name: 'Reserve a study room',
    goal:
      'Reserve a study room at Harbor Lane Library for the given patron, then read the confirmation screen and return the reservation reference together with the name, email and seat count it shows.',
    // with no public TARGET_URL the remote browser gets this made-up origin and we answer it locally
    targetUrl: process.env.TARGET_URL || 'https://harbor-lane.anvil.test/',
    inputSchema: { name: 'string', email: 'string', seats: 'number' },
    canary: '.site-header',
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
  };
}
