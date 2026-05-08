// Shared utilities for the main process and the route-* modules. Renderer
// code uses its own humanBytes() (different scale + defensive against NaN);
// the bridge through preload.js doesn't shuttle helpers across processes.

const os = require('os');

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// NOT idempotent: re-running on the output re-escapes the ampersands in
// entities (so &lt; → &amp;lt;). Callers that re-render server output need
// to escape exactly once at the boundary.
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}

// Returns the first non-internal IPv4 from os.networkInterfaces(), or
// 127.0.0.1 if every interface is loopback / down. Defensive against the
// `iface` array being undefined on platforms where the interface name has
// no addresses configured.
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name];
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

module.exports = { humanSize, escapeHtml, getLocalIP };
