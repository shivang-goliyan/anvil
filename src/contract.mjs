// A contract is learned from the first good result (the golden sample). Non-empty is not the same as
// correct, so it checks in two tiers:
// - invariants, never relaxed: required fields filled, types, fields that echo the inputs, fields that
//   must agree with each other (what the confirmation page said vs what the site stored), record count
// - learned details, which a site may legitimately change: numeric ranges and the shape of codes such as
//   booking references. A change there is drift: it is reported, and once every invariant holds the
//   contract is amended instead of the capability being called broken.

// "HL-3B9AC9" -> "AA-XXXXXX", "BK-2026-4821-07" -> "AA-9999-9999-99". Only for short code-like values.
export function shapeOf(value) {
  const s = String(value ?? '');
  if (!s || s.length > 40 || /\s/.test(s)) return null;
  return s.replace(/[A-Za-z0-9]+/g, (t) => (/^[A-Za-z]+$/.test(t) ? 'A' : /^\d+$/.test(t) ? '9' : 'X').repeat(t.length));
}

export function deriveContract(records, inputs) {
  const sample = records[0] ?? {};
  // required means filled in on every golden record, not just the first
  const requiredFields = Object.keys(sample).filter((k) => records.every((r) => r[k] !== null && r[k] !== undefined && r[k] !== ''));
  const fieldTypes = Object.fromEntries(requiredFields.map((k) => [k, typeof sample[k]]));

  const bounds = {};
  for (const k of requiredFields) {
    if (typeof sample[k] !== 'number') continue;
    const lo = Math.min(...records.map((r) => r[k]));
    const hi = Math.max(...records.map((r) => Math.abs(r[k])));
    bounds[k] = { min: lo >= 0 ? 0 : lo * 10, max: hi === 0 ? 100 : hi * 10 };
  }

  // fields that simply repeat what we typed in must keep repeating it
  const echoes = {};
  if (records.length === 1)
    for (const k of requiredFields)
      for (const [inputKey, inputVal] of Object.entries(inputs))
        if (String(sample[k]) === String(inputVal)) echoes[k] = inputKey;

  // stored_x is what the site's own records say; it has to agree with x from the confirmation page
  const agreements = {};
  if (records.length === 1)
    for (const k of requiredFields) {
      const plain = k.replace(/^stored_/, '');
      if (k !== plain && requiredFields.includes(plain) && String(sample[k]) === String(sample[plain])) agreements[k] = plain;
    }

  const formats = {};
  if (records.length === 1)
    for (const k of requiredFields) {
      if (echoes[k] || typeof sample[k] !== 'string') continue;
      const shape = shapeOf(sample[k]);
      if (shape) formats[k] = { shapes: [shape], example: sample[k] };
    }

  // lists shrink and grow a little, so the floor is half of what the golden run saw
  const minRecords = records.length > 1 ? Math.max(1, Math.floor(records.length / 2)) : 1;
  return { goldenSample: records, requiredFields, fieldTypes, minRecords, bounds, echoes, agreements, formats };
}

export function checkContract(contract, records, inputs) {
  const problems = [];
  const drift = [];
  // nothing at all is a broken read; fewer than before, each one complete, is a list the site made shorter
  if (records.length === 0 && contract.minRecords > 0) problems.push(`got 0 record(s), need at least ${contract.minRecords}`);
  else if (records.length < contract.minRecords) drift.push({ kind: 'count', value: records.length, text: `got ${records.length} records, fewer than the ${contract.minRecords} expected so far` });

  records.forEach((r, i) => {
    const at = records.length > 1 ? ` in record ${i + 1}` : '';
    for (const f of contract.requiredFields) {
      if (r[f] === null || r[f] === undefined || r[f] === '') {
        problems.push(`"${f}" is missing${at}`);
        continue;
      }
      if (typeof r[f] !== contract.fieldTypes[f]) problems.push(`"${f}" should be a ${contract.fieldTypes[f]} but is ${typeof r[f]}${at}`);
      const echoKey = contract.echoes?.[f];
      if (echoKey && String(r[f]) !== String(inputs[echoKey])) problems.push(`"${f}" should echo input "${echoKey}" (${inputs[echoKey]}) but shows "${r[f]}"${at}`);
      const partner = contract.agreements?.[f];
      if (partner && String(r[f]) !== String(r[partner])) problems.push(`"${f}" (${r[f]}) does not agree with "${partner}" (${r[partner]})${at}`);

      const b = contract.bounds?.[f];
      if (b && typeof r[f] === 'number' && (r[f] < b.min || r[f] > b.max)) drift.push({ field: f, kind: 'bounds', value: r[f], text: `"${f}" = ${r[f]} is outside the ${b.min}..${b.max} seen so far` });
      const fmt = contract.formats?.[f];
      const shape = fmt && shapeOf(r[f]);
      if (fmt && shape && !fmt.shapes.includes(shape) && !drift.some((d) => d.field === f && d.kind === 'format'))
        drift.push({ field: f, kind: 'format', shape, value: r[f], text: `"${f}" now looks like ${r[f]} (${shape}) instead of ${fmt.example} (${fmt.shapes.join(' or ')})` });
    }
  });
  return { pass: problems.length === 0, problems, drift };
}

// Learns from a result that passed every invariant: widens ranges and accepts the new code shapes.
export function amendContract(contract, records, drift) {
  const next = { bounds: structuredClone(contract.bounds ?? {}), formats: structuredClone(contract.formats ?? {}), minRecords: contract.minRecords };
  const changes = [];
  for (const d of drift) {
    if (d.kind === 'bounds') {
      const b = next.bounds[d.field];
      b.min = Math.min(b.min, d.value);
      b.max = Math.max(b.max, d.value);
      changes.push(`"${d.field}" may now be ${d.value}`);
    } else if (d.kind === 'count') {
      next.minRecords = Math.max(1, Math.floor(d.value / 2));
      changes.push(`${d.value} records is fine now (at least ${next.minRecords})`);
    } else if (d.kind === 'format') {
      const f = next.formats[d.field];
      if (!f.shapes.includes(d.shape)) f.shapes.push(d.shape);
      changes.push(`"${d.field}" may now look like ${d.value}`);
    }
  }
  return { ...next, changes };
}
