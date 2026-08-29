// Shared inline SVG vocabulary for navigation and controls.
const ICON_PATHS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16" />',
  close: '<path d="m6 6 12 12M18 6 6 18" />',
  previous: '<path d="m15 6-6 6 6 6" />',
  next: '<path d="m9 6 6 6-6 6" />',
  settings: '<path d="M4 6h10M18 6h2M10 12h10M4 12h2M4 18h8M16 18h4" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="14" cy="18" r="2" />',
  today: '<path d="M5 4h14v16H5zM8 2v4M16 2v4M5 9h14" /><path d="m8 14 2.2 2L16 11" />',
  logs: '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />',
  plan: '<path d="M12 3 4 7v10l8 4 8-4V7zM4 7l8 4 8-4M12 11v10" />',
  lift: '<path d="M3 10v4M6 7v10M18 7v10M21 10v4M6 12h12" />',
  trends: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />',
  camera: '<path d="M4 7h4l1.5-2h5L16 7h4v12H4z" /><circle cx="12" cy="13" r="3.5" />',
  image: '<path d="M4 5h16v14H4z" /><circle cx="9" cy="10" r="1.5" /><path d="m5 17 4-4 3 3 2-2 5 3" />',
  search: '<circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />',
  send: '<path d="m5 12 7-7 7 7M12 5v14" />',
  more: '<path d="m6 9 6 6 6-6" />',
  edit: '<path d="M4 20h4l11-11-4-4L4 16zM13.5 6.5l4 4" />',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />',
  repeat: '<path d="M20 7h-9a6 6 0 1 0 5.5 8.5M20 7l-3-3M20 7l-3 3" />',
};

function uiIcon(name, size, className) {
  const path = ICON_PATHS[name] || ICON_PATHS.more;
  return `<svg class="ui-icon${className ? ` ${className}` : ''}" width="${size || 18}" height="${size || 18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
}

function hydrateIcons(root) {
  (root || document).querySelectorAll('[data-ui-icon]').forEach(el => {
    el.innerHTML = uiIcon(el.dataset.uiIcon, +(el.dataset.iconSize || 18));
  });
}
