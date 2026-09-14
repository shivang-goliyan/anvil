// Tier B capability against the project's own target site.
// The plan below is hand-written. Every later version of it is derived.

import { capId, sandboxHost } from '../src/tenants.mjs';

// sandbox: a visitor's own copy of the demo site, reached on its own made-up host
export function reserveRoom(sandbox = '') {
  return {
    id: capId('reserve-room', sandbox),
    name: 'Reserve a study room',
    goal:
      'Reserve a study room at Harbor Lane Library for the given patron, room, date and time, read the reference and details off the confirmation page, then look the booking up on the library\'s "Find my booking" page by reference and email and read back what the library actually stored.',
    // with no public TARGET_URL the remote browser gets this made-up origin and we answer it locally
    targetUrl: (!sandbox && process.env.TARGET_URL) || `https://${sandboxHost(sandbox)}/`,
    inputSchema: { name: 'string', email: 'string', seats: 'number', room: 'string', date: 'string', time: 'string' },
    canary: '.site-header',
    steps: [
      { kind: 'navigate', url: '/' },
      { kind: 'fill', selector: 'input[name="full_name"]', value: '{{name}}' },
      { kind: 'fill', selector: 'input[name="email"]', value: '{{email}}' },
      { kind: 'fill', selector: 'input[name="seats"]', value: '{{seats}}' },
      { kind: 'select', selector: 'select[name="room"]', value: '{{room}}' },
      { kind: 'fill', selector: 'input[name="date"]', value: '{{date}}' },
      { kind: 'select', selector: 'select[name="time"]', value: '{{time}}' },
      // the one step that makes the booking; repairs rehearse everything before it
      { kind: 'submit', selector: '#reserve-form button[type="submit"]', commit: true },
      { kind: 'assert', selector: '#reference' },
      {
        kind: 'extract',
        fields: {
          reference: { selector: '#reference', type: 'string' },
          name: { selector: '.summary-name', type: 'string' },
          email: { selector: '.summary-email', type: 'string' },
          seats: { selector: '.summary-seats', type: 'number' },
          room: { selector: '.summary-room', type: 'string' },
          date: { selector: '.summary-date', type: 'string' },
          time: { selector: '.summary-time', type: 'string' },
        },
      },
      // second channel: what the library stored, not what the confirmation page says
      { kind: 'navigate', url: '/find' },
      { kind: 'fill', selector: 'input[name="reference"]', value: '{{out.reference}}' },
      { kind: 'fill', selector: '#find-email', value: '{{email}}' },
      { kind: 'submit', selector: '#find-form button[type="submit"]' },
      { kind: 'assert', selector: '.booking-record' },
      {
        kind: 'extract',
        fields: {
          stored_reference: { selector: '[data-record="reference"]', type: 'string' },
          stored_name: { selector: '[data-record="name"]', type: 'string' },
          stored_email: { selector: '[data-record="email"]', type: 'string' },
          stored_seats: { selector: '[data-record="seats"]', type: 'number' },
          stored_room: { selector: '[data-record="room"]', type: 'string' },
          stored_date: { selector: '[data-record="date"]', type: 'string' },
          stored_time: { selector: '[data-record="time"]', type: 'string' },
        },
      },
    ],
  };
}
