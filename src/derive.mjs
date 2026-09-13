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
- Use only selectors that exist in the markup you are given. Prefer [name="..."] or #id for form controls.
- A flow can span several pages. Every submit leads to the next page; the step after it must use selectors from that page.
  You are shown the entry page and every other page seen so far (where the old plan and earlier attempts got stuck).
  Use the selectors on those pages. Only for a page you have not been shown, keep the previous plan's selectors.
- Do not repeat a plan that an earlier attempt already showed to fail.
- Fill values must be {{inputKey}} placeholders using the input keys provided, never literal data.
- The extract step must produce exactly the output fields listed, with the listed types, from the final page.
- If a previous plan is given, keep every step that still matches and change only what the site change broke.
- Respond with the JSON object only.`;

export async function derivePlan({ goal, entryUrl, inputKeys, outputFields, previousPlan, failure, pages = [], changes, shape, markup, rejections = [] }) {
  const prompt = [
    `GOAL\n${goal}`,
    `ENTRY URL\n${entryUrl}`,
    `INPUT KEYS\n${inputKeys.join(', ')}`,
    `OUTPUT FIELDS (name: type)\n${Object.entries(outputFields).map(([k, t]) => `${k}: ${t}`).join('\n')}`,
    previousPlan && `PREVIOUS PLAN (worked before the site changed)\n${JSON.stringify(previousPlan.steps, null, 1)}`,
    failure && `HOW IT FAILED\n${failure}`,
    ...pages.map((p) => `A PAGE SEEN WHILE RUNNING (${p.url}, trimmed)\n${p.html}`),
    changes?.length && `WHAT CHANGED ON THE ENTRY PAGE SINCE THE PREVIOUS PLAN WAS MADE\n- ${changes.join('\n- ')}`,
    `ENTRY PAGE STRUCTURE (live)\n${JSON.stringify(shape)}`,
    `ENTRY PAGE FORM MARKUP (live, trimmed)\n${markup}`,
    rejections.length && `EARLIER ATTEMPTS THAT FAILED, DO NOT REPEAT THEM\n- ${rejections.join('\n- ')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { data, model, ms, skipped } = await askForJson({ system: SYSTEM, prompt });
  return { plan: { steps: data.steps }, model, ms, skipped, promptChars: prompt.length };
}

const PICK_SYSTEM = `You choose which web page best serves a goal.
Respond with JSON {"url": "<one of the candidate urls, exactly>", "why": "<one short sentence>"}.
Pick the page whose own content holds the data the goal asks for, not a page that only links to it.`;

const SHORTLIST_SYSTEM = `You shortlist pages of a website that probably hold the data a goal asks for.
Respond with JSON {"urls": ["<up to 2 urls copied exactly from the list>"], "why": "<one short sentence>"}. Prefer listing or table pages over single items. Return an empty list if nothing fits.`;

// links: [{ url, text }] where text is the link's anchor text when we have it
export async function shortlistLinks({ goal, entryUrl, links }) {
  const lines = links.map((l) => (l.text ? `${l.url}   "${l.text}"` : l.url));
  const prompt = `GOAL\n${goal}\n\nSITE\n${entryUrl}\n\nLINKS FOUND ON THE SITE (url, then the link text where known)\n${lines.join('\n')}`;
  const { data, model, ms, skipped } = await askForJson({ system: SHORTLIST_SYSTEM, prompt });
  const known = new Set(links.map((l) => l.url));
  return { urls: Array.isArray(data.urls) ? data.urls.filter((u) => known.has(u)).slice(0, 2) : [], why: data.why ?? '', model, ms, skipped };
}

export async function pickPage({ goal, candidates }) {
  const prompt = [`GOAL\n${goal}`, ...candidates.map((c, i) => `CANDIDATE ${i + 1}: ${c.url}\n${c.excerpt}`)].join('\n\n');
  const { data, model, ms, skipped } = await askForJson({ system: PICK_SYSTEM, prompt });
  return { url: data.url, why: data.why ?? '', model, ms, skipped };
}

const READ_SYSTEM = `You write read-only extraction plans for one web page, as JSON.

Respond with {"fields": {...}, "canary": "<css>", "steps": [...]}:
- "fields" maps each output field (snake_case) straight to its type, like {"title": "string", "price": "number"}. Only what the goal asks for, at most 8.
- "canary" is a CSS selector for a stable element that proves the page rendered (site header, logo, nav, footer). Not part of the data.
- "steps" is exactly these three:
  {"kind":"navigate","url":"<the page url>"}
  {"kind":"assert","selector":"<css that exists whenever the data is on the page>"}
  {"kind":"extract","each":"<css matching one element per record>","fields":{"<field>":{"selector":"<css inside that element>","type":"string"|"number","attr":"<optional attribute such as title or href>"}}}
  Leave out "each" only if the goal wants a single record; selectors are then page-wide.

Rules:
- A list or table is many records: "each" selects the repeated rows or cards, and every field is read from inside one row.
  Never invent a field per item (no usd_rate, eur_rate, first_title, second_title).
- Use only selectors that exist in the HTML given. Prefer class names and ids over positions.
- Field selectors are relative to the "each" element. An empty selector "" reads the record element itself.
- If the visible text is shortened but the full value is in an attribute (title, href), read the attribute.
- For numbers select the element holding the number; currency symbols and commas are stripped for you.
- Respond with the JSON object only.`;

export async function deriveReadPlan({ goal, url, markdown, html, feedback }) {
  const prompt = [
    `GOAL\n${goal}`,
    `PAGE URL\n${url}`,
    `PAGE TEXT (markdown, trimmed)\n${markdown}`,
    `PAGE HTML (scripts and most attributes removed, repeated items cut to three)\n${html}`,
    feedback && `YOUR LAST PLAN WAS REJECTED\n${feedback}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const { data, model, ms, skipped } = await askForJson({ system: READ_SYSTEM, prompt });
  return { fields: data.fields, canary: data.canary, plan: { steps: data.steps }, model, ms, skipped, promptChars: prompt.length };
}

const WIRE_SYSTEM = `You decide whether a prebuilt website action already does what a goal asks.
Respond with JSON {"action_id": "<an action_id from the list, or null>", "params": {...}, "why": "<one short sentence>"}.
Choose an action only if running it returns the data the goal asks for directly. Fill params from the goal and the page URL;
fall back to a parameter's default only where the goal says nothing. If no action fits, action_id is null.`;

export async function chooseWireAction({ goal, url, actions }) {
  const list = actions.map((a) => ({ action_id: a.action_id, name: a.name, description: a.description, parameters: a.parameters }));
  const prompt = `GOAL\n${goal}\n\nPAGE URL\n${url}\n\nACTIONS\n${JSON.stringify(list, null, 1)}`;
  const { data, model, ms, skipped } = await askForJson({ system: WIRE_SYSTEM, prompt });
  return { actionId: data.action_id ?? null, params: data.params ?? {}, why: data.why ?? '', model, ms, skipped };
}
