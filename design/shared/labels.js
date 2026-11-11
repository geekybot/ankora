/* Ankora: user-facing names that the copy session may still rename (copy doc revision 4 pending).
   Edit ONLY this object; every page (landing, /lend, app) relabels its visible text from it.
   Keys are the words as written in the pages; values are what readers see. */
window.ANKORA_LABELS = {
  Senior: 'Senior',
  Junior: 'Junior',
  senior: 'senior',
  junior: 'junior',
};

/* Replaces whole-word tranche names in text nodes and aria-labels under `root`. Data keys in attributes are left alone. */
window.ankoraRelabel = function (root) {
  const L = window.ANKORA_LABELS;
  if (!root || Object.keys(L).every(k => L[k] === k)) return;
  const re = /\b(Senior|Junior|senior|junior)\b/g;
  const swap = s => s.replace(re, m => (m in L ? L[m] : m));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { const v = swap(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
  root.querySelectorAll('[aria-label]').forEach(el => { const v = swap(el.getAttribute('aria-label')); if (v !== el.getAttribute('aria-label')) el.setAttribute('aria-label', v); });
};
document.addEventListener('DOMContentLoaded', () => window.ankoraRelabel(document.body));
