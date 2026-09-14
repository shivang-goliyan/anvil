// Tier B capability against the project's own target site.
// Its first plan is learned from the goal sentence below (demo/learned-booking.json, made by
// scripts/learn-booking.mjs). The hand-written steps are a test fixture: the bench uses them so results stay
// comparable, and they are the fallback when nothing has been learned and learning cannot run.

import { readFileSync } from 'node:fs';
import { capId, sandboxHost } from '../src/tenants.mjs';

const LEARNED = new URL('../demo/learned-booking.json', import.meta.url);

// what a booking has to hand back: the confirmation page, then the library's own record of it
const OUTPUTS = {
  reference: 'string',
  name: 'string',
  email: 'string',
  seats: 'number',
  room: 'string',
  date: 'string',
  time: 'string',
  stored_reference: 'string',
  stored_name: 'string',
  stored_email: 'string',
  stored_seats: 'number',
  stored_room: 'string',
  stored_date: 'string',
  stored_time: 'string',
};

function learnedBooking() {
  try {
    const saved = JSON.parse(readFileSync(LEARNED, 'utf8'));
    return Array.isArray(saved.steps) && saved.steps.length ? saved : null;
  } catch {
    return null;
  }
}

// one sample booking to learn with, a few days ahead so the date is always in the future
export const sampleBooking = () => ({ name: 'Priya Raman', email: 'priya.raman@example.com', seats: 3, room: 'Quiet room', date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), time: '11:00' });

// sandbox: a visitor's own copy of the demo site, reached on its own made-up host
export function reserveRoom(sandbox = '') {
  const targetUrl = (!sandbox && process.env.TARGET_URL) || `https://${sandboxHost(sandbox)}/`;
  return {
    id: capId('reserve-room', sandbox),
    name: 'Reserve a study room',
    goal:
      'Reserve a study room at Harbor Lane Library for the given patron, room, date and time, read the reference and details off the confirmation page, then look the booking up on the library\'s "Find my booking" page by reference and email and read back what the library actually stored.',
    // with no public TARGET_URL the remote browser gets this made-up origin and we answer it locally
    targetUrl,
    outputs: OUTPUTS,
    learned: learnedBooking(),
    learn: () => ({ goal: reserveRoom(sandbox).goal, url: targetUrl, inputs: sampleBooking(), outputs: OUTPUTS }),
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
