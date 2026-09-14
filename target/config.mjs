// The target site renders entirely from this object. Breaks mutate it at runtime and stack.

export const ROOMS = ['Quiet room', 'Group room', 'Media room'];
export const SLOTS = ['09:00', '11:00', '14:00', '16:00'];
// shown on the sign-in page itself, for everyone: the "require sign-in" change never asks a visitor for anything
export const DEMO_ACCOUNT = { email: 'demo@harborlane.org', password: 'reading-room' };
export const EVENTS = [
  { title: 'Poetry night', date: '2026-09-18', time: '18:00', room: 'Media room', seats: 12 },
  { title: 'Homework club', date: '2026-09-19', time: '16:00', room: 'Group room', seats: 5 },
  { title: 'Local history talk', date: '2026-09-21', time: '11:00', room: 'Media room', seats: 20 },
  { title: 'Chess for beginners', date: '2026-09-22', time: '14:00', room: 'Quiet room', seats: 8 },
  { title: 'Book swap', date: '2026-09-24', time: '09:00', room: 'Group room', seats: 30 },
  { title: 'Coding for kids', date: '2026-09-26', time: '11:00', room: 'Media room', seats: 0 },
];
// the full redesign renames every box and splits the form into a wizard
export const WIZARD = {
  room: { name: 'space', label: 'Pick a space' },
  date: { name: 'visit_day', label: 'Which day?' },
  time: { name: 'slot', label: 'Arrival slot' },
  name: { name: 'patron_full_name', label: "Who's coming?" },
  email: { name: 'reach_me_at', label: 'Where we send the confirmation' },
  seats: { name: 'party_count', label: 'People in your group' },
};

export function freshConfig() {
  return {
    version: 1,
    org: 'Harbor Lane Library',
    title: 'Reserve a study room',
    submitLabel: 'Reserve room',
    fields: [
      { key: 'name', name: 'full_name', label: 'Full name', type: 'text', required: true },
      { key: 'email', name: 'email', label: 'Email', type: 'email', required: true },
      { key: 'seats', name: 'seats', label: 'Seats', type: 'number', required: true, min: 1, max: 8 },
      { key: 'room', name: 'room', label: 'Room', type: 'select', required: true, options: ROOMS },
      { key: 'date', name: 'date', label: 'Date', type: 'date', required: true },
      { key: 'time', name: 'time', label: 'Time', type: 'select', required: true, options: SLOTS },
    ],
    // off by default, switched on by breaks 2 to 4
    reviewStep: false,
    seatsFirst: false,
    receiptLayout: false,
    formId: 'reserve-form',
    confirm: { reference: 'reference', name: 'summary-name', email: 'summary-email', seats: 'summary-seats', room: 'summary-room', date: 'summary-date', time: 'summary-time' },
    // traps: the site lies on its confirmation page, or changes how references look
    wrongRoom: false,
    referenceStyle: 'HL',
    // wording and colours only; nothing a booking depends on
    intro: 'Rooms seat up to eight. We hold a room for fifteen minutes past the start time.',
    banner: null,
    colors: { ink: '#1f3a2e', paper: '#f6f4ef' },
    // the harder changes: how the site is built, not what its boxes are called
    jsApp: false,
    appSalt: 'a1',
    iframe: false,
    signIn: false,
    redesign: false,
    captcha: false,
    // the events page, for the capability that only reads
    eventsLayout: 'list',
    breaks: [],
  };
}

const COSMETIC_LABELS = { name: 'Your name', email: 'Email address', seats: 'How many seats', room: 'Which room', date: 'Day', time: 'Start time' };

export const BREAKS = {
  'rename-field': 'Rename the email field',
  'add-step': 'Add a review step before the booking is made',
  'reorder-steps': 'Ask for seats first, on a page of their own',
  'restyle-confirmation': 'Rebuild the confirmation page markup',
  surprise: 'A random change nobody scripted',
  'wrong-room': 'Quietly book a different room than the one asked for, while the confirmation page shows the right one',
  'new-reference-format': 'Switch booking references to a new format',
  cosmetic: 'Change only the wording and colours: new title, labels and banner, same form underneath',
  'js-app': 'Rebuild the booking page as a JavaScript app: drawn in the browser, generated class names, no ids or names, booked without a page load',
  iframe: 'Move the booking form into an iframe',
  'sign-in': 'Require signing in before booking, with a demo account shown on the sign-in page',
  redesign: 'Redesign everything at once: a three-step wizard, radio buttons, every box renamed, a new confirmation page',
  captcha: 'Add a captcha to the booking form',
  'events-redesign': 'Redesign the events page: the list of cards becomes a table with new names for everything',
  custom: 'A change the visitor typed in',
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const tag = () => Math.random().toString(36).slice(2, 5);
const SYNONYMS = {
  name: { words: ['name', 'fullname', 'patron', 'guest', 'who'], labels: ['Your name', 'Name on the booking', 'Guest name', 'Who is booking?'] },
  email: { words: ['email', 'mail', 'contact', 'inbox', 'address'], labels: ['Email address', 'Where should we write?', 'Contact email', 'Your e-mail'] },
  seats: { words: ['seats', 'party', 'people', 'headcount', 'size'], labels: ['How many people?', 'Party size', 'Number of seats', 'Group size'] },
  room: { words: ['room', 'space', 'area', 'kind'], labels: ['Which room?', 'Space', 'Room type', 'Pick a room'] },
  date: { words: ['date', 'day', 'when', 'visit'], labels: ['Day of your visit', 'When?', 'Booking date', 'Date of visit'] },
  time: { words: ['time', 'slot', 'start', 'hour'], labels: ['Start time', 'Time slot', 'Arriving at', 'Which slot?'] },
};

// Surprise: two or three mutations picked and named at random on the spot, so nobody, including
// whoever wrote this demo, knows ahead of time what the plan will run into. At least one of them
// always breaks the plan the capability has now.
function surprise(config) {
  const done = [];
  const mutations = {
    rename() {
      const f = pick(config.fields);
      const s = SYNONYMS[f.key];
      const before = f.name;
      f.name = `${pick(s.words)}_${tag()}`;
      f.label = pick(s.labels.filter((l) => l !== f.label));
      done.push(`the ${f.key} field is now name="${f.name}", labelled "${f.label}" (was "${before}")`);
    },
    shuffle() {
      const before = config.fields.map((f) => f.key).join(', ');
      for (let i = 0; i < 6 && config.fields.map((f) => f.key).join(', ') === before; i++) config.fields.sort(() => Math.random() - 0.5);
      done.push(`the fields now come in the order ${config.fields.map((f) => f.label).join(', ')}`);
    },
    form() {
      config.formId = `${pick(['book', 'booking', 'room', 'request', 'hold'])}-${tag()}`;
      config.submitLabel = pick(['Book it', 'Confirm booking', 'Hold my room', 'Request room', 'Continue'].filter((l) => l !== config.submitLabel));
      done.push(`the form is now #${config.formId} and its button says "${config.submitLabel}"`);
    },
    confirmation() {
      const t = tag();
      config.confirm = { reference: `${pick(['code', 'ref', 'booking', 'ticket'])}-${t}`, name: `who-${t}`, email: `mail-${t}`, seats: `count-${t}`, room: `space-${t}`, date: `day-${t}`, time: `slot-${t}` };
      done.push(`the confirmation page now shows the reference in #${config.confirm.reference}, with renamed detail classes`);
    },
  };
  const breaking = pick(['rename', 'form', 'confirmation']);
  const others = Object.keys(mutations).filter((k) => k !== breaking).sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.5 ? 1 : 2);
  for (const name of [breaking, ...others]) mutations[name]();
  mark(config, { kind: 'surprise', changes: done });
  return { changed: true, detail: done.join('; ') };
}

// Custom: whatever a visitor typed, checked only so the site stays a working booking form.
const TEXT = /^[\p{L}\p{N} ?!.,'’()&:+-]+$/u;
function custom(config, { field, label, button, order } = {}) {
  const done = [];
  const clean = (v, max, what) => {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (t.length > max || !TEXT.test(t)) throw new Error(`${what} can be up to ${max} letters, numbers, spaces and simple punctuation`);
    return t;
  };
  const newLabel = clean(label, 40, 'a label');
  const newButton = clean(button, 30, 'button text');

  if (newLabel) {
    const f = config.fields.find((x) => x.key === field);
    if (!f) throw new Error('pick which box to rename');
    const base = newLabel.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
    let name = /^[a-z]/.test(base) ? base : `box_${base}`.replace(/_+$/, '');
    while (name === 't' || config.fields.some((x) => x !== f && x.name === name)) name = `${name}_${tag()}`;
    const before = f.name;
    Object.assign(f, { name, label: newLabel });
    done.push(before === name ? `the ${f.key} box is now labelled "${newLabel}"` : `the ${f.key} box is now name="${name}", labelled "${newLabel}" (was "${before}")`);
  }
  if (newButton && newButton !== config.submitLabel) {
    config.submitLabel = newButton;
    done.push(`the button now says "${newButton}"`);
  }
  if (order) {
    const keys = String(order).split(',');
    const current = config.fields.map((f) => f.key);
    if (keys.length !== current.length || [...keys].sort().join() !== [...current].sort().join()) throw new Error('the order has to list every box once');
    if (keys.join() !== current.join()) {
      config.fields.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
      done.push(`the boxes now come in the order ${config.fields.map((f) => f.label).join(', ')}`);
    }
  }
  if (!done.length) throw new Error('that would not change anything on the site');
  mark(config, { kind: 'custom', changes: done });
  return { changed: true, detail: done.join('; ') };
}

function mark(config, entry) {
  config.version += 1;
  config.breaks.push({ ...entry, at: new Date().toISOString() });
}

// break kind 1
export function renameField(config, key = 'email') {
  const field = config.fields.find((f) => f.key === key);
  if (!field) throw new Error(`no field with key "${key}"`);
  const renames = {
    name: { name: 'patron_name', label: 'Patron name' },
    email: { name: 'contact_email', label: 'Contact email' },
    seats: { name: 'party_size', label: 'Party size' },
  };
  const next = renames[key];
  if (field.name === next.name) return { changed: false, detail: `${key} is already renamed` };
  const before = field.name;
  Object.assign(field, next);
  mark(config, { kind: 'rename-field', key, from: before, to: next.name });
  return { changed: true, detail: `renamed "${before}" to "${next.name}"` };
}

function toggle(config, kind, flag, detail) {
  if (config[flag]) return { changed: false, detail: 'that break is already in place' };
  config[flag] = true;
  mark(config, { kind });
  return { changed: true, detail };
}

export function applyBreak(config, kind, key, params) {
  if (kind === 'rename-field') return renameField(config, key);
  if (kind === 'add-step') return toggle(config, kind, 'reviewStep', 'bookings now go through a "check your details" page with its own confirm button');
  if (kind === 'reorder-steps') return toggle(config, kind, 'seatsFirst', 'the form is now two pages, seats first, then everything else');
  if (kind === 'restyle-confirmation') return toggle(config, kind, 'receiptLayout', 'the confirmation page was rebuilt with different markup');
  if (kind === 'surprise') return surprise(config);
  if (kind === 'wrong-room') return toggle(config, kind, 'wrongRoom', 'the site now books a different room than the one chosen, and its confirmation page still shows the chosen one');
  if (kind === 'new-reference-format') {
    if (config.referenceStyle === 'BK') return { changed: false, detail: 'references already use the new format' };
    config.referenceStyle = 'BK';
    mark(config, { kind });
    return { changed: true, detail: 'booking references now look like BK-2026-4821-07 instead of HL-3B9AC9' };
  }
  if (kind === 'cosmetic') {
    if (config.banner) return { changed: false, detail: 'the new wording and colours are already in place' };
    Object.assign(config, {
      title: 'Book a quiet place to study',
      intro: 'Every room seats up to eight people. Arrive within fifteen minutes of your start time and the room is yours.',
      banner: 'New this term: the library stays open until 9pm on weekdays.',
      colors: { ink: '#5b2a86', paper: '#fbf7ff' },
    });
    const before = config.fields.map((f) => f.label);
    for (const f of config.fields) f.label = COSMETIC_LABELS[f.key] ?? f.label;
    mark(config, { kind });
    return { changed: true, detail: `new title "${config.title}", a banner, purple colours, and the boxes now read ${config.fields.map((f) => `"${f.label}"`).join(', ')} (were ${before.map((l) => `"${l}"`).join(', ')}). Box names, the form and the button are unchanged` };
  }
  if (kind === 'js-app') {
    if (config.jsApp) return { changed: false, detail: 'the booking page is already a JavaScript app' };
    config.appSalt = tag() + tag();
    return toggle(config, kind, 'jsApp', 'the booking page is now a JavaScript app: the form is drawn in the browser with generated class names and no ids or names, the booking is sent with fetch, and the confirmation is drawn in place');
  }
  if (kind === 'iframe') return toggle(config, kind, 'iframe', 'the booking form now sits inside an iframe on the page');
  if (kind === 'sign-in') return toggle(config, kind, 'signIn', `booking now needs signing in first; the sign-in page shows a demo account (${DEMO_ACCOUNT.email})`);
  if (kind === 'redesign') return toggle(config, kind, 'redesign', 'everything was redesigned at once: a three-step wizard (when, who, check), radio buttons for the room and time, every box renamed, and a new confirmation page');
  if (kind === 'captcha') return toggle(config, kind, 'captcha', 'the booking form now has a captcha');
  if (kind === 'events-redesign') {
    if (config.eventsLayout === 'table') return { changed: false, detail: 'the events page is already a table' };
    config.eventsLayout = 'table';
    mark(config, { kind });
    return { changed: true, detail: 'the events page was redesigned: its list of event cards is now a table, with new class names and column names for everything' };
  }
  if (kind === 'custom') return custom(config, params);
  throw new Error(`unknown break kind "${kind}"`);
}

// A plain description of the site right now, for people looking at the demo.
export function describe(config) {
  const byKey = Object.fromEntries(config.fields.map((f) => [f.key, f]));
  const field = (f) => `${f.label} (name="${f.name}")`;
  const captcha = config.captcha ? ', a captcha' : '';
  const pages = config.signIn ? ['sign-in: the demo account is shown on the page, then Sign in'] : [];
  if (config.jsApp) {
    pages.push(`one JavaScript app page: ${config.fields.map((f) => f.label).join(', ')}${captcha}, then ${config.submitLabel}, booked without a page load`, 'confirmation: drawn by JavaScript in place');
  } else if (config.redesign) {
    const w = (k) => `${WIZARD[k].label} (name="${WIZARD[k].name}")`;
    pages.push(`step 1: ${w('room')} as radio buttons, ${w('date')}, ${w('time')} as radio buttons, then Next`, `step 2: ${w('name')}, ${w('email')}, ${w('seats')}, then Next`, `step 3: check it${captcha}, then Book this room`, 'confirmation: a redesigned ticket');
  } else {
    const frame = config.iframe ? ' (inside an iframe)' : '';
    const last = config.reviewStep ? '' : captcha;
    if (config.seatsFirst) pages.push(`page 1${frame}: ${field(byKey.seats)}, then Continue`, `page 2: the other boxes${last}, then ${config.submitLabel}`);
    else pages.push(`page 1${frame}: ${config.fields.map(field).join(', ')}${last}, then ${config.submitLabel}`);
    if (config.reviewStep) pages.push(`page ${pages.length + 1}: check your details${captcha}, then Confirm reservation`);
    pages.push(`confirmation: ${config.receiptLayout ? 'receipt layout (rebuilt markup)' : 'original layout'}`);
  }
  pages.push(`events page: ${config.eventsLayout === 'table' ? 'a table (redesigned)' : 'a list of event cards'}`);
  return { version: config.version, pages, breaks: config.breaks };
}
