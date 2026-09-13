// The target site renders entirely from this object. Breaks mutate it at runtime and stack.

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
    ],
    // off by default, switched on by breaks 2 to 4
    reviewStep: false,
    seatsFirst: false,
    receiptLayout: false,
    breaks: [],
  };
}

export const BREAKS = {
  'rename-field': 'Rename the email field',
  'add-step': 'Add a review step before the booking is made',
  'reorder-steps': 'Ask for seats first, on a page of their own',
  'restyle-confirmation': 'Rebuild the confirmation page markup',
};

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

export function applyBreak(config, kind, key) {
  if (kind === 'rename-field') return renameField(config, key);
  if (kind === 'add-step') return toggle(config, kind, 'reviewStep', 'bookings now go through a "check your details" page with its own confirm button');
  if (kind === 'reorder-steps') return toggle(config, kind, 'seatsFirst', 'the form is now two pages, seats first, then name and email');
  if (kind === 'restyle-confirmation') return toggle(config, kind, 'receiptLayout', 'the confirmation page was rebuilt with different markup');
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
