import { createHash } from 'node:crypto';
import { parse, TextNode } from 'node-html-parser';

const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

// What a page looks like structurally: forms, fields, buttons, headings.
// Content-free on purpose so the hash only moves when structure moves.
export function pageShape(html) {
  const root = parse(html);
  const labelFor = new Map(root.querySelectorAll('label[for]').map((l) => [l.getAttribute('for'), text(l)]));

  const forms = root.querySelectorAll('form').map((form) => ({
    id: form.getAttribute('id') ?? null,
    action: form.getAttribute('action') ?? null,
    method: (form.getAttribute('method') ?? 'get').toLowerCase(),
    fields: form
      .querySelectorAll('input, select, textarea')
      .filter((el) => el.getAttribute('type') !== 'hidden')
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') ?? (el.tagName.toLowerCase() === 'input' ? 'text' : null),
        name: el.getAttribute('name') ?? null,
        id: el.getAttribute('id') ?? null,
        label: labelFor.get(el.getAttribute('id')) ?? (text(el.closest('label')) || null),
        required: el.hasAttribute('required'),
      })),
    buttons: form.querySelectorAll('button, input[type="submit"]').map((b) => ({
      type: b.getAttribute('type') ?? 'submit',
      text: text(b) || b.getAttribute('value') || '',
    })),
  }));

  const headings = root.querySelectorAll('h1, h2').map(text).filter(Boolean);
  const frames = root.querySelectorAll('iframe').map((f) => f.getAttribute('id') ?? f.getAttribute('src') ?? 'iframe');
  // only present when there are frames, so pages without any keep the hash they always had
  const shape = { title: text(root.querySelector('title')), headings, forms, ...(frames.length && { frames }) };
  return { shape, hash: createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16) };
}

// Just the form markup, trimmed, for the model to read. Never the whole page.
export function formMarkup(html, limit = 6000) {
  const root = parse(html);
  const forms = root.querySelectorAll('form');
  const chunk = forms.length
    ? forms
        .map((f) => {
          const frame = f.closest('[data-anvil-frame]')?.getAttribute('data-anvil-frame');
          return `${frame ? `<!-- this form is inside ${frame}: its steps need "frame": "${frame}" -->\n` : ''}${f.outerHTML}`;
        })
        .join('\n')
    : (root.querySelector('main') ?? root).outerHTML;
  return chunk.replace(/\s{2,}/g, ' ').slice(0, limit);
}

const KEEP_ATTRS = new Set(['id', 'class', 'href', 'src', 'title', 'alt', 'itemprop', 'role', 'aria-label', 'datetime', 'name', 'type', 'placeholder', 'for', 'action', 'value', 'target']);
const LIST_AT = 8;
const DROP_TAGS = 'script, style, noscript, svg, link, meta, template, head';

// The body with scripts, styles and most attributes gone, long text clipped, and long runs of
// look-alike siblings cut to three. Enough for a model to write selectors against.
export function compactHtml(html, limit = 24000) {
  const root = parse(html, { comment: false });
  for (const el of root.querySelectorAll(DROP_TAGS)) el.remove();
  const body = root.querySelector('body') ?? root;

  const walk = (el) => {
    if (el.attributes) {
      for (const name of Object.keys(el.attributes)) {
        // data-* hooks are often the most stable selector on a page, when they are short labels and not blobs
        const hook = /^data-[\w-]+$/i.test(name) && String(el.getAttribute(name)).length <= 40;
        if (!KEEP_ATTRS.has(name.toLowerCase()) && !hook) el.removeAttribute(name);
        else if ((name === 'href' || name === 'src') && el.getAttribute(name).length > 80) el.setAttribute(name, `${el.getAttribute(name).slice(0, 80)}…`);
      }
    }
    const kids = (el.childNodes ?? []).filter((n) => n.nodeType === 1);
    const sigOf = (kid) => {
      const cls = (kid.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).join('.');
      return `${kid.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };
    const counts = new Map();
    for (const kid of kids) counts.set(sigOf(kid), (counts.get(sigOf(kid)) ?? 0) + 1);
    // a real list is cut to three; a handful of look-alike rows (the details on a confirmation page) all stay
    const seen = new Map();
    for (const kid of kids) {
      const sig = sigOf(kid);
      const n = (seen.get(sig) ?? 0) + 1;
      seen.set(sig, n);
      if (counts.get(sig) > LIST_AT && n > 3) kid.remove();
      else walk(kid);
    }
    for (const [sig, n] of seen) if (n > LIST_AT) el.appendChild(new TextNode(` [${n - 3} more ${sig} like the ones above] `, el));
  };
  walk(body);

  return body.toString()
    .replace(/>([^<]{160,})</g, (_, t) => `>${t.replace(/\s+/g, ' ').slice(0, 120)}…<`)
    .replace(/\s{2,}/g, ' ')
    .slice(0, limit);
}

export function diffShapes(before, after) {
  if (!before) return ['no earlier snapshot to compare against'];
  const changes = [];
  if (before.title !== after.title) changes.push(`title changed from "${before.title}" to "${after.title}"`);
  if (JSON.stringify(before.headings) !== JSON.stringify(after.headings))
    changes.push(`headings changed from ${JSON.stringify(before.headings)} to ${JSON.stringify(after.headings)}`);
  if (before.forms.length !== after.forms.length) changes.push(`form count went from ${before.forms.length} to ${after.forms.length}`);
  if (JSON.stringify(before.frames ?? []) !== JSON.stringify(after.frames ?? [])) changes.push(`iframes on the page went from ${JSON.stringify(before.frames ?? [])} to ${JSON.stringify(after.frames ?? [])}`);

  const n = Math.max(before.forms.length, after.forms.length);
  for (let i = 0; i < n; i++) {
    const a = before.forms[i];
    const b = after.forms[i];
    if (!a || !b) continue;
    const where = `form ${b.id ? `#${b.id}` : i + 1}`;
    if (a.id !== b.id) changes.push(`form id changed from "${a.id ?? 'none'}" to "${b.id ?? 'none'}"`);
    if (a.action !== b.action) changes.push(`${where}: action changed from "${a.action}" to "${b.action}"`);

    const oldNames = new Set(a.fields.map((f) => f.name));
    const newNames = new Set(b.fields.map((f) => f.name));
    const gone = a.fields.filter((f) => !newNames.has(f.name));
    const added = b.fields.filter((f) => !oldNames.has(f.name));

    for (const g of gone) {
      const at = a.fields.indexOf(g);
      const twin = added.find((x) => b.fields.indexOf(x) === at && x.type === g.type);
      if (twin) {
        changes.push(`${where}: field "${g.name}" (label "${g.label}") is gone; ${/^[aeiou]/.test(twin.type) ? 'an' : 'a'} ${twin.type} field "${twin.name}" (label "${twin.label}") sits in the same position, likely a rename`);
        added.splice(added.indexOf(twin), 1);
      } else {
        changes.push(`${where}: field "${g.name}" (label "${g.label}") was removed`);
      }
    }
    for (const x of added) changes.push(`${where}: new ${x.required ? 'required ' : ''}field "${x.name}" (label "${x.label}") at position ${b.fields.indexOf(x) + 1}`);

    for (const f of b.fields) {
      const old = a.fields.find((o) => o.name === f.name);
      if (!old) continue;
      if (old.label !== f.label) changes.push(`${where}: field "${f.name}" label changed from "${old.label}" to "${f.label}"`);
      if (old.required !== f.required) changes.push(`${where}: field "${f.name}" is ${f.required ? 'now' : 'no longer'} required`);
    }
    const oldOrder = a.fields.map((f) => f.name).filter((x) => newNames.has(x));
    const newOrder = b.fields.map((f) => f.name).filter((x) => oldNames.has(x));
    if (JSON.stringify(oldOrder) !== JSON.stringify(newOrder)) changes.push(`${where}: field order changed from ${oldOrder.join(', ')} to ${newOrder.join(', ')}`);

    const oldButtons = a.buttons.map((x) => x.text).join(' | ');
    const newButtons = b.buttons.map((x) => x.text).join(' | ');
    if (oldButtons !== newButtons) changes.push(`${where}: buttons changed from "${oldButtons}" to "${newButtons}"`);
  }
  return changes.length ? changes : ['no structural change detected on the entry page'];
}
