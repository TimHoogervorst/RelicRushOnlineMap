const welcome = document.querySelector('#welcome-screen');
const storageKey = 'rr-map-welcome-seen-v1';
let seen = false;
try { seen = localStorage.getItem(storageKey) === 'true'; } catch { /* Storage is optional. */ }
if (!seen) welcome.showModal();
document.querySelector('#welcome-open').addEventListener('click', () => {
  document.querySelector('#copy-server-status').textContent = '';
  if (!welcome.open) welcome.showModal();
});
function rememberVisit() {
  try { localStorage.setItem(storageKey, 'true'); } catch { /* Still allow access to the map. */ }
}
welcome.addEventListener('close', rememberVisit);
welcome.querySelector('form').addEventListener('submit', rememberVisit);

document.querySelector('#copy-server-ip').addEventListener('click', async () => {
  const address = 'mc.wereldbouw.net';
  const status = document.querySelector('#copy-server-status');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(address);
    status.textContent = 'Server IP copied! See you in the dungeon.';
  } catch {
    // Support HTTP deployments and browsers that deny the Clipboard API.
    const field = document.createElement('textarea');
    field.value = address;
    field.setAttribute('aria-label', 'Server IP');
    field.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    welcome.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Offer manual copying below. */ }
    field.remove();
    document.querySelector('#copy-server-ip').focus();
    status.textContent = copied ? 'Server IP copied! See you in the dungeon.' : `Could not copy automatically. Copy this address: ${address}`;
  }
});
