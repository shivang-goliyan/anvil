// The target site renders entirely from this object. Breaks mutate it at runtime.

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
    breaks: [],
  };
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
  config.version += 1;
  config.breaks.push({ kind: 'rename-field', key, from: before, to: next.name, at: new Date().toISOString() });
  return { changed: true, detail: `renamed "${before}" to "${next.name}"` };
}
