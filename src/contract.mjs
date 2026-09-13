// A contract is learned from the first good result (the golden sample).
// Non-empty is not the same as correct, so it checks types, counts, ranges and echoes.

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

  // lists shrink and grow a little, so the floor is half of what the golden run saw
  const minRecords = records.length > 1 ? Math.max(1, Math.floor(records.length / 2)) : 1;
  return { goldenSample: records, requiredFields, fieldTypes, minRecords, bounds, echoes };
}

export function checkContract(contract, records, inputs) {
  const problems = [];
  if (records.length < contract.minRecords) problems.push(`got ${records.length} record(s), need at least ${contract.minRecords}`);

  records.forEach((r, i) => {
    const at = records.length > 1 ? ` in record ${i + 1}` : '';
    for (const f of contract.requiredFields) {
      if (r[f] === null || r[f] === undefined || r[f] === '') {
        problems.push(`"${f}" is missing${at}`);
        continue;
      }
      if (typeof r[f] !== contract.fieldTypes[f]) problems.push(`"${f}" should be a ${contract.fieldTypes[f]} but is ${typeof r[f]}${at}`);
      const b = contract.bounds[f];
      if (b && typeof r[f] === 'number' && (r[f] < b.min || r[f] > b.max)) problems.push(`"${f}" = ${r[f]} is outside ${b.min}..${b.max}${at}`);
      const echoKey = contract.echoes[f];
      if (echoKey && String(r[f]) !== String(inputs[echoKey])) problems.push(`"${f}" should echo input "${echoKey}" (${inputs[echoKey]}) but shows "${r[f]}"${at}`);
    }
  });
  return { pass: problems.length === 0, problems };
}
