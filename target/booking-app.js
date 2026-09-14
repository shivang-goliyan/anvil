// The "JavaScript app" version of the booking page: drawn in the browser, class names that look generated,
// no ids or names on anything, the booking sent with fetch and the confirmation drawn in place.
(() => {
  const boot = JSON.parse(document.getElementById('boot').textContent);
  const root = document.getElementById('app-root');
  const c = (k) => `_${[...`${boot.salt}${k}`].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36).slice(0, 6)}`;
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) k === 'text' ? (n.textContent = v) : n.setAttribute(k, v);
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  };

  function form(error, captchaHtml = boot.captcha) {
    const controls = boot.fields.map((f) =>
      f.type === 'select'
        ? el('select', { class: c('pick'), 'aria-label': f.label }, el('option', { value: '', text: 'Choose…' }), ...f.options.map((o) => el('option', { text: o })))
        : el('input', { class: c('box'), 'aria-label': f.label, type: f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text' }),
    );
    const rows = boot.fields.map((f, i) => el('div', { class: c('row') }, el('span', { class: c('lbl'), text: f.label }), controls[i]));
    const captcha = captchaHtml ? el('div', { class: c('cap') }) : null;
    if (captcha) captcha.innerHTML = captchaHtml;
    const button = el('button', { class: c('go'), type: 'button', text: boot.submitLabel });
    button.addEventListener('click', async () => {
      button.disabled = true;
      const body = Object.fromEntries(boot.fields.map((f, i) => [f.key, controls[i].value]));
      if (captcha) Object.assign(body, { captcha: captcha.querySelector('[name="captcha"]').value, captcha_t: captcha.querySelector('[name="captcha_t"]').value });
      const res = await fetch('/api/reserve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({ error: 'Something went wrong, try again.' }));
      if (res.status === 401) return location.assign('/sign-in?next=/');
      if (!res.ok) return root.replaceChildren(form(out.error, out.captcha ?? null));
      history.pushState(null, '', `/reservations/${out.reference}`);
      root.replaceChildren(ticket(out));
    });
    return el(
      'div',
      { class: c('card') },
      el('h1', { class: c('title'), text: boot.title }),
      el('p', { class: c('intro'), text: boot.intro }),
      error ? el('p', { class: c('err'), role: 'alert', text: error }) : null,
      ...rows,
      captcha,
      button,
    );
  }

  function ticket(r) {
    const lines = [['Name', r.name], ['Email', r.email], ['Seats', r.seats], ['Room', r.room], ['Date', r.date], ['Time', r.time]];
    return el(
      'div',
      { class: c('done') },
      el('h1', { class: c('title'), text: 'Room reserved' }),
      el('p', { class: c('refline') }, 'Your reference is ', el('strong', { class: c('ref'), text: r.reference })),
      el('dl', { class: c('sum') }, ...lines.flatMap(([k, v]) => [el('dt', { class: c('k'), text: k }), el('dd', { class: c('v'), text: String(v) })])),
    );
  }

  const booked = location.pathname.match(/^\/reservations\/([A-Z0-9-]+)$/);
  if (!booked) root.replaceChildren(form());
  else
    fetch(`/api/reservations/${booked[1]}`)
      .then((r) => r.json())
      .then((r) => root.replaceChildren(r.reference ? ticket(r) : el('h1', { text: 'No such reservation' })));
})();
