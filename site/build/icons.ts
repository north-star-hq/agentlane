const card = (paths: string) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${paths}</svg>`;

export const ICONS: Record<string, string> = {
  plug: card('<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>'),
  phone: card('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  eye: card('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  shield: card('<path d="M12 3l7.5 3v5.5c0 4.6-3.2 7.9-7.5 9.5-4.3-1.6-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12l2.3 2.3 4.2-4.6"/>'),
  play: card('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.2 9.2l4.6 2.8-4.6 2.8z"/>'),
  cycle: card(
    '<path d="M4.5 11a7.5 7.5 0 0 1 13.2-4.3L19.5 8.5"/><path d="M19.5 4v4.5H15"/><path d="M19.5 13a7.5 7.5 0 0 1-13.2 4.3L4.5 15.5"/><path d="M4.5 20v-4.5H9"/>',
  ),
  star: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>',
};
