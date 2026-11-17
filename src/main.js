// Entry point. In an Artifact viewer, `window.claude.hot` lets an open game
// survive a republish; everywhere else it is simply absent.
import { boot, thaw } from './ui.js';

const hot = (typeof window !== 'undefined' && window.claude && window.claude.hot) || null;
function begin(data) {
  let saved = null;
  try { if (data && data.save) saved = thaw(data.save); } catch (e) { saved = null; }
  const snapshot = boot(saved);
  try { if (hot && hot.snapshot) hot.snapshot(() => ({ save: snapshot() })); } catch (e) { /* not in a viewer */ }
}
if (hot && hot.ready) hot.ready(begin); else begin((hot && hot.data) || {});
