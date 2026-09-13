import { askForJson } from './llm.mjs';

const SYSTEM = `You write browser automation plans for a website, as JSON.

A plan is {"steps": [...]} where each step is one of:
  {"kind":"navigate","url":"<absolute url or path>"}
  {"kind":"fill","selector":"<css>","value":"{{inputKey}}"}
  {"kind":"click","selector":"<css>"}
  {"kind":"submit","selector":"<css of the submit control>"}   (clicks and waits for the next page)
  {"kind":"assert","selector":"<css that must be visible>"}
  {"kind":"extract","fields":{"<outputField>":{"selector":"<css>","type":"string"|"number"}}}

Rules:
- Use only selectors that exist in the page structure you are given. Prefer [name="..."] or #id for form controls.
- Fill values must be {{inputKey}} placeholders using the input keys provided, never literal data.
- The extract step must produce exactly the output fields listed, with the listed types.
- If a previous plan is given, keep every step that still matches the page and change only what the page change broke.
- Respond with the JSON object only.`;

export async function derivePlan({ goal, entryUrl, inputKeys, outputFields, previousPlan, failure, changes, shape, markup, feedback }) {
  const prompt = [
    `GOAL\n${goal}`,
    `ENTRY URL\n${entryUrl}`,
    `INPUT KEYS\n${inputKeys.join(', ')}`,
    `OUTPUT FIELDS (name: type)\n${Object.entries(outputFields).map(([k, t]) => `${k}: ${t}`).join('\n')}`,
    previousPlan && `PREVIOUS PLAN (worked before the site changed)\n${JSON.stringify(previousPlan.steps, null, 1)}`,
    failure && `HOW IT FAILED\n${failure}`,
    changes?.length && `WHAT CHANGED ON THE ENTRY PAGE SINCE THE PREVIOUS PLAN WAS MADE\n- ${changes.join('\n- ')}`,
    `ENTRY PAGE STRUCTURE (live)\n${JSON.stringify(shape)}`,
    `ENTRY PAGE FORM MARKUP (live, trimmed)\n${markup}`,
    feedback && `YOUR LAST ATTEMPT WAS REJECTED\n${feedback}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { data, model, ms, skipped } = await askForJson({ system: SYSTEM, prompt });
  return { plan: { steps: data.steps }, model, ms, skipped, promptChars: prompt.length };
}
