window.VIVIDHATA_EVENTS = [
  {
    id: 'hackathon-2026',
    category: 'HACKATHON',
    name: 'EVENT NAME',
    description: 'EVENT DESCRIPTION',
    date: 'DD MONTH 2026',
    time: '00:00 PM',
    venue: 'VENUE NAME',
    deadline: 'REGISTRATION DEADLINE',
    prize: 'PRIZE POOL: INR 00,000',
    status: 'UPCOMING',
    poster: 'icon_hackathon.jpg',
    posterAlt: 'Hackathon placeholder poster',
    detailsUrl: 'event-details.html?event=hackathon-2026',
    registrationUrl: 'registration.html?event=hackathon-2026',
    registration: { enabled: true, fields: [] }
  },
  {
    id: 'workshop-2026',
    category: 'WORKSHOP',
    name: 'EVENT NAME',
    description: 'EVENT DESCRIPTION',
    date: 'DD MONTH 2026',
    time: '00:00 AM',
    venue: 'VENUE NAME',
    deadline: 'REGISTRATION DEADLINE',
    prize: '',
    status: 'UPCOMING',
    poster: 'tech_developer.png',
    posterAlt: 'Workshop placeholder poster',
    detailsUrl: 'event-details.html?event=workshop-2026',
    registrationUrl: 'registration.html?event=workshop-2026',
    registration: { enabled: true, fields: [] }
  },
  {
    id: 'competition-2026',
    category: 'COMPETITION',
    name: 'EVENT NAME',
    description: 'EVENT DESCRIPTION',
    date: 'DD MONTH 2026',
    time: '00:00 PM',
    venue: 'VENUE NAME',
    deadline: 'REGISTRATION DEADLINE',
    prize: 'PRIZE POOL: INR 00,000',
    status: 'UPCOMING',
    poster: 'frames/storm2.webp',
    posterAlt: 'Competition placeholder poster',
    detailsUrl: 'event-details.html?event=competition-2026',
    registrationUrl: 'registration.html?event=competition-2026',
    registration: { enabled: true, fields: [] }
  }
];

window.VIVIDHATA_EVENT_UTILS = {
  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[character]));
  },

  getEventById(eventId) {
    const normalizedId = typeof eventId === 'string' ? eventId.trim() : '';
    return window.VIVIDHATA_EVENTS.find(event => event.id === normalizedId) || null;
  },

  getDetailsUrl(event) {
    const fallback = `event-details.html?event=${encodeURIComponent(event.id)}`;
    return this.isSafeUrl(event.detailsUrl) ? event.detailsUrl : fallback;
  },

  isSafeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },

  isExternalRegistrationUrl(url) {
    if (!this.isSafeUrl(url)) return false;
    const parsed = new URL(url, window.location.href);
    return parsed.origin !== window.location.origin;
  },

  isPlaceholderRegistrationUrl(url, eventId) {
    if (!this.isSafeUrl(url)) return false;
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin &&
      parsed.pathname.endsWith('/registration.html') &&
      parsed.searchParams.get('event') === eventId;
  },

  getRegistrationState(event) {
    if (event.status === 'COMPLETED') return 'closed';
    if (event.registration?.enabled === false) return 'disabled';
    if (!this.isSafeUrl(event.registrationUrl) || this.isPlaceholderRegistrationUrl(event.registrationUrl, event.id)) {
      return 'soon';
    }
    return 'open';
  }
};
