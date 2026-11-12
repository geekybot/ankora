/* Accent toggle (teal or apricot), shared with the landing through localStorage. */

/* Accent toggle (teal or apricot), shared with the app through localStorage. */
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('[data-accent-toggle]')) return;
  const next = document.documentElement.dataset.accent === 'apricot' ? '' : 'apricot';
  if (next) document.documentElement.dataset.accent = next; else delete document.documentElement.dataset.accent;
  try { localStorage.setItem('ankora.accent', next); } catch { /* private mode */ }
  dispatchEvent(new Event('ankora:accent'));
});
export {};
