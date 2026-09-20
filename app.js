/*
 * The app deliberately reads the existing state and RSS feed at runtime.
 * No meeting data is copied into this repository, so the view stays current
 * when the integration workflow publishes new state or agenda items.
 */
const DATA_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? '/einnsyn-state.json'
  : 'https://raw.githubusercontent.com/monsivar/einnsyn-teams-integration-Buskerud-Ap/refs/heads/main/einnsyn-state.json';
const FEED_URL = './feedV2.xml';

const state = { meetings: [], view: 'upcoming', filters: { search: '', committee: '', agenda: 'all', range: 'all' } };
const els = {};

document.addEventListener('DOMContentLoaded', () => {
  Object.assign(els, {
    list: document.querySelector('#meeting-list'), loading: document.querySelector('#loading'), empty: document.querySelector('#empty-state'), error: document.querySelector('#error-banner'),
    sync: document.querySelector('#sync-status'), visible: document.querySelector('#visible-count'), visibleLabel: document.querySelector('#visible-label'), agendaCount: document.querySelector('#agenda-count'), lastSync: document.querySelector('#last-sync'), resultCount: document.querySelector('#result-count'),
    title: document.querySelector('#page-title'), resultTitle: document.querySelector('#results-title'), kicker: document.querySelector('#results-kicker'), upcomingTab: document.querySelector('[data-view="upcoming"]'), historyTab: document.querySelector('[data-view="history"]'), upcomingTabCount: document.querySelector('#upcoming-tab-count'), historyTabCount: document.querySelector('#history-tab-count'),
    search: document.querySelector('#search-input'), committee: document.querySelector('#committee-filter'), agenda: document.querySelector('#agenda-filter'), range: document.querySelector('#range-filter'), rangeField: document.querySelector('#range-field'), reset: document.querySelector('#reset-filters')
  });
  bindControls();
  loadData();
});

function bindControls() {
  document.querySelectorAll('.view-tab').forEach(button => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    state.filters.range = 'all';
    els.range.value = state.filters.range;
    els.rangeField.hidden = state.view === 'history';
    document.querySelectorAll('.view-tab').forEach(tab => tab.classList.toggle('is-active', tab === button));
    render();
  }));
  els.search.addEventListener('input', event => { state.filters.search = event.target.value.trim().toLocaleLowerCase('nb-NO'); render(); });
  els.committee.addEventListener('change', event => { state.filters.committee = event.target.value; render(); });
  els.agenda.addEventListener('change', event => { state.filters.agenda = event.target.value; render(); });
  els.range.addEventListener('change', event => { state.filters.range = event.target.value; render(); });
  els.reset.addEventListener('click', () => {
    state.filters = { search: '', committee: '', agenda: 'all', range: 'all' };
    els.search.value = ''; els.committee.value = ''; els.agenda.value = 'all'; els.range.value = state.filters.range; render();
  });
}

async function loadData() {
  try {
    const [stateResponse, feedResponse] = await Promise.all([fetch(DATA_URL, { cache: 'no-store' }), fetch(FEED_URL, { cache: 'no-store' })]);
    if (!stateResponse.ok) throw new Error(`State kunne ikke hentes (${stateResponse.status})`);
    const stateJson = await stateResponse.json();
    const feedText = feedResponse.ok ? await feedResponse.text() : '';
    state.meetings = normalizeMeetings(Array.isArray(stateJson) ? stateJson : [], parseFeed(feedText));
    populateCommittees();
    els.loading.hidden = true;
    els.sync.classList.add('is-ready');
    els.sync.innerHTML = '<span class="status-dot"></span> Siste data lastet';
    els.lastSync.textContent = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit' }).format(new Date());
    render();
  } catch (error) {
    els.loading.hidden = true;
    els.error.hidden = false;
    els.error.innerHTML = `<strong>Kunne ikke hente møteoversikten.</strong><span>${escapeHtml(error.message)}. Prøv å laste siden på nytt.</span>`;
  }
}

function normalizeMeetings(rawMeetings, feedByMeeting) {
  const now = new Date();
  return rawMeetings.map(raw => {
    const meetingId = raw.meetingId || raw.id || '';
    const feed = feedByMeeting.get(meetingId) || feedByMeeting.get(publicId(raw.meetingId)) || {};
    const cases = mergeCases(raw.agendaCases, feed.cases);
    const date = new Date(raw.meetingDateUtc || raw.meetingDate || feed.date);
    const meetingUrl = safeUrl(raw.meetingUrl) || publicMeetingUrl(meetingId) || safeUrl(feed.meetingUrl);
    const agendaUrl = safeUrl(raw.agendaUrl) || safeUrl(feed.agendaUrl) || documentUrl(raw.agendaDocumentObjectId);
    return { id: meetingId, title: raw.title || feed.title || 'Møte', committee: raw.committee || feed.committee || 'Politisk organ', date, place: raw.meetingPlace || feed.place || '', agendaAvailable: Boolean(raw.agendaAvailable || cases.length || feed.agendaAvailable), agendaUrl, meetingUrl, cases, protocolAvailable: Boolean(raw.protocolAvailable || feed.protocol), protocolUrl: safeUrl(raw.protocolUrl) || safeUrl(feed.protocolUrl), past: date < now };
  }).filter(meeting => meeting.id && !Number.isNaN(meeting.date.getTime())).sort((a, b) => a.date - b.date);
}

function parseFeed(xmlText) {
  const result = new Map();
  if (!xmlText) return result;
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  xml.querySelectorAll('item').forEach(item => {
    const description = item.querySelector('description')?.textContent || '';
    const match = description.match(/\{\s*"schemaVersion"[\s\S]*\}/);
    if (!match) return;
    try {
      const payload = JSON.parse(match[0]);
      const meeting = payload.meeting || {};
      const id = meeting.id || decodeMeetingId(item.querySelector('link')?.textContent || '');
      if (!id) return;
      const isAgenda = String(payload.eventType || '').startsWith('AGENDA_') && Array.isArray(payload.cases);
      const current = result.get(id);
      if (isAgenda && (!current || new Date(item.querySelector('pubDate')?.textContent || 0) > current.feedDate)) {
        result.set(id, { id, title: meeting.title, committee: meeting.committee, date: meeting.date, place: meeting.place, meetingUrl: meeting.meetingUrl, agendaUrl: meeting.agendaUrl, agendaAvailable: true, cases: payload.cases, feedDate: new Date(item.querySelector('pubDate')?.textContent || 0) });
      } else if (!current) {
        result.set(id, { id, title: meeting.title, committee: meeting.committee, date: meeting.date, place: meeting.place, meetingUrl: meeting.meetingUrl, agendaUrl: meeting.agendaUrl, protocol: payload.protocol, protocolUrl: payload.protocol?.url, cases: [] });
      }
    } catch { /* Ignore malformed historical RSS items. */ }
  });
  return result;
}

function mergeCases(stateCases = [], feedCases = []) {
  const byNumber = new Map();
  [...stateCases, ...feedCases].forEach(item => {
    const number = item.number || item.caseNumber || '';
    if (!number) return;
    const previous = byNumber.get(number) || {};
    byNumber.set(number, { ...previous, ...item, caseUrl: safeUrl(item.caseUrl) || publicCaseUrl(item.id || item.caseId), documents: item.documents || previous.documents || [], recommendation: item.recommendation || previous.recommendation });
  });
  return [...byNumber.values()].sort((a, b) => String(a.number).localeCompare(String(b.number), 'nb-NO', { numeric: true }));
}

function render() {
  const visible = getVisibleMeetings();
  const upcoming = state.meetings.filter(meeting => !meeting.past);
  const history = state.meetings.filter(meeting => meeting.past);
  els.upcomingTabCount.textContent = upcoming.length;
  els.historyTabCount.textContent = history.length;
  els.visible.textContent = visible.length;
  els.visibleLabel.textContent = state.view === 'upcoming' ? 'kommende møter' : 'historiske møter';
  els.agendaCount.textContent = visible.filter(meeting => meeting.agendaAvailable).length;
  els.resultCount.textContent = `${visible.length} ${visible.length === 1 ? 'møte' : 'møter'}`;
  els.title.textContent = state.view === 'upcoming' ? 'Møter som kommer' : 'Historiske møter';
  els.resultTitle.textContent = state.view === 'upcoming' ? 'Neste på kalenderen' : 'Tidligere møter';
  els.kicker.textContent = state.view === 'upcoming' ? 'KOMMENDE MØTER' : 'HISTORIKK';
  els.list.innerHTML = visible.map(renderMeeting).join('');
  els.empty.hidden = visible.length !== 0;
}

function getVisibleMeetings() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rangeDays = state.filters.range === 'all' ? Infinity : Number(state.filters.range);
  const limit = new Date(today); limit.setDate(limit.getDate() + rangeDays);
  return state.meetings.filter(meeting => {
    if (state.view === 'upcoming' ? meeting.past : !meeting.past) return false;
    if (state.view === 'upcoming' && meeting.date > limit) return false;
    if (state.filters.committee && meeting.committee !== state.filters.committee) return false;
    if (state.filters.agenda === 'ready' && !meeting.agendaAvailable) return false;
    if (state.filters.agenda === 'pending' && meeting.agendaAvailable) return false;
    if (state.filters.search) {
      const haystack = [meeting.title, meeting.committee, meeting.place, ...meeting.cases.map(item => `${item.number} ${item.title}`)].join(' ').toLocaleLowerCase('nb-NO');
      if (!haystack.includes(state.filters.search)) return false;
    }
    return true;
  });
}

function renderMeeting(meeting) {
  const date = new Intl.DateTimeFormat('nb-NO', { day: '2-digit', month: 'short', year: 'numeric' }).formatToParts(meeting.date);
  const day = date.find(part => part.type === 'day')?.value || '';
  const month = (date.find(part => part.type === 'month')?.value || '').replace('.', '');
  const year = date.find(part => part.type === 'year')?.value || '';
  const time = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit' }).format(meeting.date);
  const status = meeting.agendaAvailable ? '<span class="pill ready">● Agenda klar</span>' : '<span class="pill pending">● Agenda kommer</span>';
  const actions = [meeting.meetingUrl ? `<a class="action primary" href="${attrUrl(meeting.meetingUrl)}" target="_blank" rel="noreferrer">Åpne møte ↗</a>` : '', meeting.agendaUrl ? `<a class="action" href="${attrUrl(meeting.agendaUrl)}" target="_blank" rel="noreferrer">Agenda PDF ↗</a>` : '', meeting.protocolUrl ? `<a class="action" href="${attrUrl(meeting.protocolUrl)}" target="_blank" rel="noreferrer">Protokoll ↗</a>` : ''].join('');
  const cases = meeting.cases.length ? `<details class="agenda-details" ${state.view === 'upcoming' && meeting.agendaAvailable ? 'open' : ''}><summary>${meeting.cases.length} ${meeting.cases.length === 1 ? 'sak' : 'saker'} i sakskartet</summary><ul class="case-list">${meeting.cases.map(renderCase).join('')}</ul></details>` : '';
  return `<article class="meeting-card"><div class="date-badge"><span class="day">${escapeHtml(day)}</span><span class="month">${escapeHtml(month)}</span><span class="year">${escapeHtml(year)}</span></div><div><div class="card-topline"><span class="committee">${escapeHtml(meeting.committee)}</span>${status}</div><h3>${escapeHtml(cleanTitle(meeting.title))}</h3><div class="meta-row"><span class="meta-item">${icon('clock')} ${escapeHtml(time)}</span>${meeting.place ? `<span class="meta-item">${icon('pin')} ${escapeHtml(meeting.place)}</span>` : '<span class="meta-item">Sted ikke publisert ennå</span>'}</div><div class="card-actions">${actions}</div>${cases}</div></article>`;
}

function renderCase(item) {
  const title = item.title || 'Uten tittel';
  const content = item.caseUrl ? `<a href="${attrUrl(item.caseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(title)} ↗</a>` : escapeHtml(title);
  const recommendation = item.recommendation?.text ? `<div class="recommendation"><strong>Innstilling:</strong> ${escapeHtml(item.recommendation.text)}</div>` : '';
  return `<li class="case-item"><span class="case-number">${escapeHtml(item.number || 'Sak')}</span><span>${content}${recommendation}</span></li>`;
}

function populateCommittees() {
  const committees = [...new Set(state.meetings.map(meeting => meeting.committee))].sort((a, b) => a.localeCompare(b, 'nb-NO'));
  els.committee.innerHTML = '<option value="">Alle organer</option>' + committees.map(committee => `<option value="${escapeHtml(committee)}">${escapeHtml(committee)}</option>`).join('');
}

function cleanTitle(title) { return title.replace(/^Møte i\s+/i, ''); }
function publicId(value) { return value ? value.split('/').pop() : ''; }
function publicMeetingUrl(id) { return id ? `https://einnsyn.no/moetemappe?id=${encodeURIComponent(id)}` : ''; }
function publicCaseUrl(id) { return id ? `https://einnsyn.no/moeteregistrering?id=${encodeURIComponent(id)}` : ''; }
function documentUrl(id) { return id && !String(id).startsWith('db_') && !String(id).startsWith('do_') ? safeUrl(id) : ''; }
function safeUrl(value) { return typeof value === 'string' && /^https:\/\//i.test(value) ? value : ''; }
function attrUrl(value) { return escapeHtml(safeUrl(value)); }
function decodeMeetingId(value) { try { return new URL(value).searchParams.get('id') || ''; } catch { return ''; } }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function icon(type) { return type === 'pin' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/></svg>'; }
