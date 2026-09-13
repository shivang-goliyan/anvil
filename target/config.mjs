// The target site renders entirely from this object. Breaks mutate it at runtime and stack.

export const ROOMS = ['Quiet room', 'Group room', 'Media room'];
export const SLOTS = ['09:00', '11:00', '14:00', '16:00'];

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
  if (kind === 'custom') return custom(config, params);
  throw new Error(`unknown break kind "${kind}"`);
}

// A plain description of the site right now, for people looking at the demo.
export function describe(config) {
  const byKey = Object.fromEntries(config.fields.map((f) => [f.key, f]));
  const field = (f) => `${f.label} (name="${f.name}")`;
  const pages = config.seatsFirst
    ? [`page 1: ${field(byKey.seats)}, then Continue`, `page 2: ${field(byKey.name)}, ${field(byKey.email)}, then ${config.submitLabel}`]
    : [`page 1: ${config.fields.map(field).join(', ')}, then ${config.submitLabel}`];
  if (config.reviewStep) pages.push(`page ${pages.length + 1}: check your details, then Confirm reservation`);
  pages.push(`confirmation: ${config.receiptLayout ? 'receipt layout (rebuilt markup)' : 'original layout'}`);
  return { version: config.version, pages, breaks: config.breaks };
}
