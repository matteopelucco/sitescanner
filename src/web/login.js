// Login page of multi-user mode (spec §10.3).
const form = document.getElementById('login');
const err = document.getElementById('err');

// RF-AUTH-08: back to the requested page, only if it is a path of this site.
function nextUrl() {
  const n = new URLSearchParams(location.search).get('next') || '/';
  return /^\/(?![/\\])/.test(n) ? n : '/';
}

fetch('/api/login').then((r) => r.json()).then((d) => {
  if (d.needsSetup) document.getElementById('setup').hidden = false;
}).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
    location.replace(nextUrl());
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
    form.password.value = '';
    form.password.focus();
  } finally {
    btn.disabled = false;
  }
});
