/*
 * The app reads the public meeting projection and RSS feed at runtime.
 * The private integration state is never copied to the public webapp.
 */
const INDEX_URL = './einnsyn-meetings-index.json';
const DATA_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? '/einnsyn-meetings-catalog.json'
  : './meetings.json';
const FEED_URL = './feedV2.xml';
const KOMMUNE_TV_URL = './einnsyn-kommune-tv.json';
const REPRESENTATIVE_REGISTRY_URLS = ['./bfk-representatives.json', '../config/bfk-representatives.json'];
const REPRESENTATIVE_DISPLAY_RULES_URLS = ['./bfk-representative-display-rules.json', '../config/bfk-representative-alias-candidates.json'];

const state = { meetings: [], representatives: [], representativeLookup: emptyRepresentativeLookup(), view: 'upcoming', filters: { search: '', committee: '', agenda: 'all', range: 'all', representative: '', representativeId: '', roles: [] } };
const els = {};

document.addEventListener('DOMContentLoaded', () => {
  Object.assign(els, {
    list: document.querySelector('#meeting-list'), loading: document.querySelector('#loading'), empty: document.querySelector('#empty-state'), error: document.querySelector('#error-banner'),
    sync: document.querySelector('#sync-status'), visible: document.querySelector('#visible-count'), visibleLabel: document.querySelector('#visible-label'), agendaCount: document.querySelector('#agenda-count'), lastSync: document.querySelector('#last-sync'), resultCount: document.querySelector('#result-count'),
    title: document.querySelector('#page-title'), resultTitle: document.querySelector('#results-title'), kicker: document.querySelector('#results-kicker'), upcomingTab: document.querySelector('[data-view="upcoming"]'), historyTab: document.querySelector('[data-view="history"]'), upcomingTabCount: document.querySelector('#upcoming-tab-count'), historyTabCount: document.querySelector('#history-tab-count'),
    search: document.querySelector('#search-input'), committee: document.querySelector('#committee-filter'), agenda: document.querySelector('#agenda-filter'), range: document.querySelector('#range-filter'), rangeField: document.querySelector('#range-field'), reset: document.querySelector('#reset-filters'), representative: document.querySelector('#representative-filter'), representativeSuggestions: document.querySelector('#representative-suggestions'), speakerRole: document.querySelector('#role-speaker'), proposerRole: document.querySelector('#role-proposer')
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
  els.representative.addEventListener('input', event => {
    state.filters.representative = event.target.value.trim().toLocaleLowerCase('nb-NO');
    state.filters.representativeId = '';
    renderRepresentativeSuggestions(event.target.value);
    render();
  });
  els.representativeSuggestions.addEventListener('click', event => {
    const option = event.target.closest('[data-representative]');
    if (!option) return;
    els.representative.value = option.dataset.representative;
    state.filters.representative = option.dataset.representative.toLocaleLowerCase('nb-NO');
    state.filters.representativeId = option.dataset.representativeId || '';
    hideRepresentativeSuggestions();
    render();
  });
  [els.speakerRole, els.proposerRole].forEach(control => control.addEventListener('change', () => {
    state.filters.roles = [els.speakerRole.checked ? 'speaker' : '', els.proposerRole.checked ? 'proposer' : ''].filter(Boolean);
    render();
  }));
  document.addEventListener('click', event => {
    if (!event.target.closest('.representative-picker')) hideRepresentativeSuggestions();
  });
  els.reset.addEventListener('click', () => {
    state.filters = { search: '', committee: '', agenda: 'all', range: 'all', representative: '', representativeId: '', roles: [] };
    els.search.value = ''; els.committee.value = ''; els.agenda.value = 'all'; els.range.value = state.filters.range; render();
    els.representative.value = ''; els.speakerRole.checked = false; els.proposerRole.checked = false; hideRepresentativeSuggestions();
  });
}

async function loadData() {
  try {
    const [rawMeetings, feedResponse, kommuneTvByMeeting, representativeRegistry, representativeDisplayRules] = await Promise.all([loadMeetings(), fetch(FEED_URL, { cache: 'no-store' }), loadKommuneTv(), loadRepresentativeRegistry(), loadRepresentativeDisplayRules()]);
    const feedText = feedResponse.ok ? await feedResponse.text() : '';
    state.representativeLookup = buildRepresentativeLookup(representativeRegistry, representativeDisplayRules);
    state.meetings = normalizeMeetings(rawMeetings, parseFeed(feedText), kommuneTvByMeeting, state.representativeLookup);
    populateCommittees();
    populateRepresentatives();
    els.loading.hidden = true;
    els.sync.classList.add('is-ready');
    els.lastSync.textContent = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit' }).format(new Date());
    render();
  } catch (error) {
    els.loading.hidden = true;
    els.error.hidden = false;
    els.error.innerHTML = `<strong>Kunne ikke hente møteoversikten.</strong><span>${escapeHtml(error.message)}. Prøv å laste siden på nytt.</span>`;
  }
}

async function loadMeetings() {
  try {
    const indexResponse = await fetch(INDEX_URL, { cache: 'no-store' });
    if (!indexResponse.ok) throw new Error(`Indeks kunne ikke hentes (${indexResponse.status})`);
    const index = await indexResponse.json();
    if (index.catalogType !== 'meeting-index' || Number(index.schemaVersion) !== 1 || !Array.isArray(index.shards)) {
      throw new Error('Møteindeksen har uventet format');
    }

    const shards = await Promise.all(index.shards.map(async shard => {
      const path = String(shard.path || '');
      if (!/^einnsyn-meetings-shards\/\d{4}-(0[1-9]|1[0-2])\.json$/.test(path)) {
        throw new Error(`Ugyldig shard-bane: ${path}`);
      }
      const response = await fetch(`./${path}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Shard kunne ikke hentes (${response.status}): ${path}`);
      const payload = await response.json();
      if (Number(payload.schemaVersion) !== 1 || payload.shardType !== 'meetings' || !Array.isArray(payload.meetings)) {
        throw new Error(`Shard har uventet format: ${path}`);
      }
      if (payload.shardKey !== shard.key || Number(payload.meetingCount) !== payload.meetings.length || Number(shard.meetingCount) !== payload.meetings.length) {
        throw new Error(`Shard-antall stemmer ikke: ${path}`);
      }
      return payload.meetings;
    }));

    const meetings = shards.flat();
    if (Number(index.meetingCount) !== meetings.length) throw new Error('Møteindeksen summerer ikke til riktig møteantall');
    return meetings;
  } catch (indexError) {
    const legacyResponse = await fetch(DATA_URL, { cache: 'no-store' });
    if (!legacyResponse.ok) throw new Error(`${indexError.message}. Fallback-data kunne ikke hentes (${legacyResponse.status})`);
    const legacy = await legacyResponse.json();
    const meetings = Array.isArray(legacy) ? legacy : legacy.meetings;
    if (!Array.isArray(meetings)) throw new Error('Fallback-data har uventet format');
    return meetings;
  }
}

function normalizeMeetings(rawMeetings, feedByMeeting, kommuneTvByMeeting, representativeLookup) {
  const now = new Date();
  return rawMeetings.map(raw => {
    const meetingId = raw.meetingId || raw.id || decodeMeetingId(raw.meetingUrl) || '';
    const meetingUrlFromState = safeUrl(raw.meetingUrl);
    const feed = feedByMeeting.get(meetingId) || feedByMeeting.get(meetingUrlFromState) || feedByMeeting.get(publicMeetingUrl(raw.meetingId)) || {};
    const catalogDecisions = Array.isArray(raw.caseDecisions) ? raw.caseDecisions : [];
    const rawCases = Array.isArray(raw.agendaCases) ? raw.agendaCases.map(item => {
      const decision = catalogDecisions.find(candidate => candidate.caseId === item.id);
      return {
        ...item,
        caseUrl: safeUrl(item.caseUrl) || publicCaseUrl(item.id),
        decisionUrl: safeUrl(item.decisionUrl) || safeUrl(decision?.publicUrl),
        metadata: normalizeCaseMetadata(item.metadata || item.caseMetadata, representativeLookup)
      };
    }) : [];
    const cases = mergeCases(rawCases, feed.cases, feed.decisions, representativeLookup);
    const date = new Date(raw.meetingDateUtc || raw.meetingDate || feed.date);
    const meetingUrl = safeUrl(raw.meetingUrl) || publicMeetingUrl(meetingId) || safeUrl(feed.meetingUrl);
    const agendaUrl = safeUrl(raw.agendaUrl) || safeUrl(feed.agendaUrl) || agendaDocumentUrl(raw.agendaDocumentObjectId);
    const protocolUrl = safeUrl(feed.protocolUrl) || safeUrl(raw.protocolUrl) || protocolDocumentUrl(raw.protocolDocumentIds);
    const kommuneTv = kommuneTvByMeeting.get(meetingId) || kommuneTvByMeeting.get(`${dateKey(date)}|${raw.committee || feed.committee || ''}`) || {};
    const enrichedCases = cases.map(item => ({ ...item, kommuneTvUrl: findKommuneTvCaseUrl(item, kommuneTv.cases) }));
    return { id: meetingId, title: raw.title || feed.title || 'Møte', committee: raw.committee || feed.committee || 'Politisk organ', date, place: raw.meetingPlace || feed.place || '', agendaAvailable: Boolean(raw.agendaAvailable || enrichedCases.length || feed.agendaAvailable), agendaUrl, meetingUrl, kommuneTvUrl: safeUrl(kommuneTv.meetingUrl), cases: enrichedCases, attendance: normalizeAttendance(raw.attendance || raw.attendanceMetadata, representativeLookup), metadataStatus: raw.metadataStatus || 'not_present', protocolAvailable: Boolean(protocolUrl), protocolUrl, past: date < now };
  }).filter(meeting => meeting.id && !Number.isNaN(meeting.date.getTime())).sort((a, b) => a.date - b.date);
}

async function loadRepresentativeRegistry() {
  for (const url of REPRESENTATIVE_REGISTRY_URLS) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload && Array.isArray(payload.parties)) return payload;
    } catch { /* The raw metadata remains usable if the optional registry is unavailable. */ }
  }
  return null;
}

async function loadRepresentativeDisplayRules() {
  for (const url of REPRESENTATIVE_DISPLAY_RULES_URLS) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload && (Array.isArray(payload.ignoredObservedNames) || Array.isArray(payload.candidates))) return payload;
    } catch { /* Display rules are optional; unmatched names remain visible as raw values. */ }
  }
  return null;
}

function emptyRepresentativeLookup() {
  return { byName: new Map(), byId: new Map(), records: [], ignoredNames: new Set() };
}

function buildRepresentativeLookup(payload, displayRules) {
  const lookup = emptyRepresentativeLookup();
  const ignoredObservedNames = Array.isArray(displayRules?.ignoredObservedNames)
    ? displayRules.ignoredObservedNames
    : Array.isArray(displayRules?.candidates)
      ? displayRules.candidates.filter(candidate => candidate.ignored && candidate.suggestionReason === 'manual-ignored-composite-name').map(candidate => candidate.observedName)
      : [];
  lookup.ignoredNames = new Set(ignoredObservedNames.map(normalizeRepresentativeName).filter(Boolean));
  if (!payload || !Array.isArray(payload.parties)) return lookup;
  payload.parties.forEach(party => {
    (Array.isArray(party.members) ? party.members : []).forEach(member => {
      const record = {
        id: String(member.id || ''),
        displayName: String(member.displayName || '').trim(),
        aliases: Array.isArray(member.aliases) ? member.aliases.map(String).map(value => value.trim()).filter(Boolean) : [],
        party: String(party.id || '').trim(),
        partyName: String(party.name || '').trim(),
        membershipType: member.membershipType || '',
      };
      if (!record.id || !record.displayName) return;
      record.searchNames = [record.displayName, ...record.aliases];
      lookup.records.push(record);
      lookup.byId.set(record.id, record);
      record.searchNames.forEach(name => {
        const key = normalizeRepresentativeName(name);
        if (key) lookup.byName.set(key, record);
      });
    });
  });
  return lookup;
}

function normalizeRepresentativeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[–—−]/g, '-')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('nb-NO')
    .replace(/\s+(?:a|ap|h|frp|inp|krf|sp|mdg|sv|v|r|pp)\.?$/, '')
    .trim();
}

function resolveRepresentative(name, lookup) {
  return lookup?.byName?.get(normalizeRepresentativeName(name)) || null;
}

function isIgnoredRepresentativeName(name, lookup) {
  return Boolean(name && lookup?.ignoredNames?.has(normalizeRepresentativeName(name)));
}

function dateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function findKommuneTvCaseUrl(item, kommuneTvCases) {
  if (!Array.isArray(kommuneTvCases)) return '';
  const caseId = String(item.id || item.caseId || '');
  const number = normalizeCaseNumber(item.number || item.caseNumber);
  const match = kommuneTvCases.find(candidate => String(candidate.einnsynCaseId || '') === caseId)
    || kommuneTvCases.find(candidate => normalizeCaseNumber(candidate.number) === number);
  return safeUrl(match?.videoUrl) || safeUrl(match?.caseUrl);
}

function normalizeCaseNumber(value) {
  return String(value || '').replace(/^\s*PS\s*/i, '').replace(/\s+/g, '').toLocaleLowerCase('nb-NO');
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
      const id = safeUrl(meeting.meetingUrl) || publicMeetingUrl(meeting.id) || decodeMeetingId(item.querySelector('link')?.textContent || '');
      if (!id) return;
      const isAgenda = String(payload.eventType || '').startsWith('AGENDA_') && Array.isArray(payload.cases);
      const current = result.get(id) || { id, title: meeting.title, committee: meeting.committee, date: meeting.date, place: meeting.place, meetingUrl: meeting.meetingUrl, agendaUrl: meeting.agendaUrl, agendaAvailable: false, cases: [], decisions: [], feedDate: new Date(0) };
      const publishedAt = new Date(item.querySelector('pubDate')?.textContent || 0);
      if (isAgenda && publishedAt > current.feedDate) {
        current.cases = payload.cases;
        current.agendaAvailable = true;
        current.feedDate = publishedAt;
      }
      if (payload.eventType === 'CASE_DECISION_AVAILABLE_V2' && payload.case && payload.document?.url) current.decisions.push({ number: payload.case.number, title: payload.case.title, decisionUrl: safeUrl(payload.document.url) });
      if (payload.eventType === 'MEETING_PROTOCOL_AVAILABLE_V2' && payload.protocol?.url) { current.protocol = payload.protocol; current.protocolUrl = safeUrl(payload.protocol.url); }
      result.set(id, current);
    } catch { /* Ignore malformed historical RSS items. */ }
  });
  return result;
}

function mergeCases(...args) {
  const representativeLookup = args.pop();
  const caseLists = args;
  const byNumber = new Map();
  caseLists.flatMap(list => Array.isArray(list) ? list : []).forEach(item => {
    const number = item.number || item.caseNumber || '';
    if (!number) return;
    const previous = byNumber.get(number) || {};
    byNumber.set(number, { ...previous, ...item, caseUrl: safeUrl(item.caseUrl) || publicCaseUrl(item.id || item.caseId) || previous.caseUrl, decisionUrl: safeUrl(item.decisionUrl) || previous.decisionUrl || '', documents: item.documents || previous.documents || [], recommendation: item.recommendation || previous.recommendation, metadata: normalizeCaseMetadata(item.metadata || item.caseMetadata || previous.metadata, representativeLookup) });
  });
  return [...byNumber.values()].sort((a, b) => String(a.number).localeCompare(String(b.number), 'nb-NO', { numeric: true }));
}

function normalizeCaseMetadata(metadata, representativeLookup) {
  if (!metadata) return null;
  const speakerSource = Array.isArray(metadata.speakers) ? metadata.speakers : metadata.speakers?.speakers;
  const proposalSource = Array.isArray(metadata.proposals) ? metadata.proposals : metadata.proposals?.proposals;
  return {
    ...metadata,
    speakers: Array.isArray(speakerSource) ? speakerSource.map(person => normalizeSpeaker(person, representativeLookup)).filter(person => person?.name) : [],
    proposals: Array.isArray(proposalSource) ? proposalSource.map(proposal => normalizeProposal(proposal, representativeLookup)).filter(proposal => proposal?.proposerName) : []
  };
}

function normalizeSpeaker(person, representativeLookup) {
  const rawName = person.observedName || person.name || person.displayName || '';
  if (isIgnoredRepresentativeName(rawName, representativeLookup)) return null;
  const representative = resolveRepresentative(rawName, representativeLookup);
  return {
    ...person,
    observedName: rawName,
    name: representative?.displayName || rawName,
    party: person.party || person.partyAtStatementRaw || representative?.party || '',
    representativeId: representative?.id || '',
    representativeAliases: representative?.searchNames || []
  };
}

function normalizeProposal(proposal, representativeLookup) {
  const rawName = proposal.observedProposerName || proposal.proposerName || '';
  if (isIgnoredRepresentativeName(rawName, representativeLookup)) return null;
  const representative = resolveRepresentative(rawName, representativeLookup);
  return {
    ...proposal,
    observedProposerName: rawName,
    proposerName: representative?.displayName || rawName,
    proposerParty: proposal.proposerParty || proposal.proposerPartyRaw || representative?.party || '',
    representativeId: representative?.id || '',
    representativeAliases: representative?.searchNames || []
  };
}

function normalizeAttendance(attendance, representativeLookup) {
  if (!attendance) return null;
  const normalizePeople = people => (Array.isArray(people) ? people : []).map(person => {
    const rawName = person.name || person.displayName || '';
    if (isIgnoredRepresentativeName(rawName, representativeLookup)) return null;
    const representative = resolveRepresentative(rawName, representativeLookup);
    return {
      ...person,
      observedName: rawName,
      name: representative?.displayName || rawName,
      representativeId: representative?.id || '',
      representativeAliases: representative?.searchNames || [],
      representedBy: person.representedBy || person.representedByRaw || person.partyName || person.party || representative?.party || ''
    };
  }).filter(person => person?.name);
  return { ...attendance, fixedMembers: normalizePeople(attendance.fixedMembers), deputies: normalizePeople(attendance.deputies) };
}

function render() {
  const visible = getVisibleMeetings();
  const upcoming = state.meetings.filter(meeting => !meeting.past);
  const history = state.meetings.filter(meeting => meeting.past && meeting.cases.length > 0);
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
  const visible = state.meetings.filter(meeting => {
    if (state.view === 'upcoming' ? meeting.past : !meeting.past) return false;
    if (state.view === 'history' && meeting.cases.length === 0) return false;
    if (state.view === 'upcoming' && meeting.date > limit) return false;
    if (state.filters.committee && meeting.committee !== state.filters.committee) return false;
    if (state.filters.agenda === 'ready' && !meeting.agendaAvailable) return false;
    if (state.filters.agenda === 'pending' && meeting.agendaAvailable) return false;
    if (state.filters.agenda === 'protocol' && !meeting.protocolAvailable) return false;
    if (state.filters.search) {
      const haystack = [meeting.title, meeting.committee, meeting.place, ...meeting.cases.map(item => `${item.number} ${item.title}`)].join(' ').toLocaleLowerCase('nb-NO');
      if (!haystack.includes(state.filters.search)) return false;
    }
    if (hasAdvancedFilter() && !meeting.cases.some(caseMatchesAdvanced)) return false;
    return true;
  });
  return visible.sort((a, b) => state.view === 'history' ? b.date - a.date : a.date - b.date);
}

function hasAdvancedFilter() {
  return Boolean(state.filters.representative || state.filters.roles.length);
}

function getMeetingCases(meeting) {
  return hasAdvancedFilter() ? meeting.cases.filter(caseMatchesAdvanced) : meeting.cases;
}

function caseMatchesAdvanced(item) {
  const metadata = item.metadata || {};
  const speakers = Array.isArray(metadata.speakers) ? metadata.speakers : [];
  const proposals = Array.isArray(metadata.proposals) ? metadata.proposals : [];
  const query = state.filters.representative;
  const personMatches = !query || speakers.some(person => representativeMatches(person, query, state.filters.representativeId)) || proposals.some(proposal => representativeMatches(proposal, query, state.filters.representativeId));
  const roleMatches = !state.filters.roles.length || state.filters.roles.some(role => role === 'speaker' ? speakers.some(person => !query || representativeMatches(person, query, state.filters.representativeId)) : proposals.some(proposal => !query || representativeMatches(proposal, query, state.filters.representativeId)));
  return personMatches && roleMatches;
}

function representativeMatches(person, query, representativeId) {
  if (representativeId) return person.representativeId === representativeId;
  const names = [person.name, person.proposerName, person.observedName, person.observedProposerName, ...(person.representativeAliases || [])];
  return names.filter(Boolean).some(name => String(name).toLocaleLowerCase('nb-NO').startsWith(query));
}

function renderMeeting(meeting) {
  const date = new Intl.DateTimeFormat('nb-NO', { day: '2-digit', month: 'short', year: 'numeric' }).formatToParts(meeting.date);
  const day = date.find(part => part.type === 'day')?.value || '';
  const month = (date.find(part => part.type === 'month')?.value || '').replace('.', '');
  const year = date.find(part => part.type === 'year')?.value || '';
  const time = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit' }).format(meeting.date);
  const status = meeting.agendaAvailable ? '<span class="pill ready">● Agenda klar</span>' : '<span class="pill pending">● Agenda kommer</span>';
  const kommuneTv = meeting.kommuneTvUrl ? `<a class="meeting-tv-link" href="${attrUrl(meeting.kommuneTvUrl)}" target="_blank" rel="noreferrer">${icon('tv')}<span>Kommune-TV</span></a>` : '';
  const actions = [meeting.meetingUrl ? `<a class="action primary" href="${attrUrl(meeting.meetingUrl)}" target="_blank" rel="noreferrer">Åpne møtet i EInnsyn ↗</a>` : '', meeting.agendaUrl ? `<a class="action" href="${attrUrl(meeting.agendaUrl)}" target="_blank" rel="noreferrer">Åpne Agenda (PDF) ↗</a>` : '', meeting.protocolUrl ? `<a class="action" href="${attrUrl(meeting.protocolUrl)}" target="_blank" rel="noreferrer">Åpne Protokoll (PDF) ↗</a>` : ''].join('');
  const visibleCases = getMeetingCases(meeting);
  const caseCount = hasAdvancedFilter() ? `${visibleCases.length} treffende ${visibleCases.length === 1 ? 'sak' : 'saker'} av ${meeting.cases.length}` : `${visibleCases.length} ${visibleCases.length === 1 ? 'sak' : 'saker'} i sakskartet`;
  const cases = visibleCases.length ? `<details class="agenda-details" ${hasAdvancedFilter() || (state.view === 'upcoming' && meeting.agendaAvailable) ? 'open' : ''}><summary>${caseCount}</summary><ul class="case-list">${visibleCases.map(renderCase).join('')}</ul></details>` : '';
  const metadata = renderMeetingMetadata(meeting);
  return `<article class="meeting-card"><div class="meeting-top"><div class="date-badge"><span class="day">${escapeHtml(day)}</span><span class="month">${escapeHtml(month)}</span><span class="year">${escapeHtml(year)}</span></div><div class="meeting-summary"><div class="card-topline"><span class="committee">${escapeHtml(meeting.committee)}</span>${status}${kommuneTv}</div><h3>${escapeHtml(cleanTitle(meeting.title))}</h3><div class="meta-row"><span class="meta-item">${icon('clock')} ${escapeHtml(time)}</span>${meeting.place ? `<span class="meta-item">${icon('pin')} ${escapeHtml(meeting.place)}</span>` : '<span class="meta-item">Sted ikke publisert ennå</span>'}</div><div class="card-actions">${actions}</div></div></div>${cases}${metadata}</article>`;
}

function renderMeetingMetadata(meeting) {
  const hasAttendance = meeting.attendance && meeting.attendance.status !== 'not_present';
  if (!hasAttendance && !meeting.cases.some(item => item.metadata)) return '';
  const attendance = hasAttendance ? `<div class="metadata-panel"><div class="metadata-panel-heading"><strong>Registrert oppmøte</strong><span class="metadata-status ${metadataStatusClass(meeting.attendance.status)}">${escapeHtml(metadataStatusLabel(meeting.attendance.status))}</span></div>${renderAttendanceGroup('Faste medlemmer', meeting.attendance.fixedMembers)}${renderAttendanceGroup('Varamedlemmer', meeting.attendance.deputies)}</div>` : '';
  const caseCount = meeting.cases.filter(item => item.metadata).length;
  return `<details class="meeting-metadata"><summary>Metadata fra protokoll og vedtak${caseCount ? ` (${caseCount} saker)` : ''}</summary>${attendance}<p class="metadata-note">Saksmetadata vises inne på den enkelte saken. Votering er foreløpig ikke strukturert.</p></details>`;
}

function renderAttendanceGroup(label, people) {
  if (!Array.isArray(people) || people.length === 0) return '';
  const groups = new Map();
  people.forEach(person => {
    const rawParty = String(person.representedBy || '').trim();
    const party = partyLabel(rawParty);
    const key = party.toLocaleLowerCase('nb-NO');
    if (!groups.has(key)) groups.set(key, { label: party, people: [] });
    groups.get(key).people.push(person);
  });
  const renderedGroups = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'nb-NO')).map(group => {
    const names = [...group.people].sort((a, b) => a.name.localeCompare(b.name, 'nb-NO'));
    return `<div class="attendance-party"><span class="metadata-label">${escapeHtml(group.label)}</span><ul class="person-list">${names.map(person => `<li><strong>${escapeHtml(person.name)}</strong></li>`).join('')}</ul></div>`;
  }).join('');
  return `<div class="metadata-group"><span class="metadata-label">${escapeHtml(label)}</span><div class="attendance-party-list">${renderedGroups}</div></div>`;
}

function partyLabel(value) {
  if (!value) return 'Uten partitilknytning';
  const key = value.replace(/[.\s_-]/g, '').toLocaleUpperCase('nb-NO');
  return ({
    A: 'Arbeiderpartiet', AP: 'Arbeiderpartiet',
    H: 'Høyre',
    FRP: 'Fremskrittspartiet',
    INP: 'Industri- og Næringspartiet',
    KRF: 'Kristelig Folkeparti',
    SP: 'Senterpartiet',
    MDG: 'Miljøpartiet De Grønne',
    SV: 'Sosialistisk Venstreparti',
    V: 'Venstre',
    R: 'Rødt',
    PP: 'Pensjonistpartiet'
  })[key] || value;
}

function renderCase(item) {
  const title = item.title || 'Uten tittel';
  const documents = (Array.isArray(item.documents) ? item.documents : []).filter(document => document && (document.role === 'attachment' || !document.role)).map(document => ({ ...document, url: safeUrl(document.url) || safeUrl(document.publicUrl) })).filter(document => document.url || document.status === 'UNAVAILABLE');
  const recommendation = item.recommendation?.text?.trim() ? `<details class="case-option recommendation-option"><summary>Vis administrativ innstilling</summary><div class="recommendation"><strong>Administrasjonens innstilling i saken:</strong><span>${escapeHtml(item.recommendation.text)}</span></div></details>` : '';
  const caseLink = item.caseUrl ? `<a class="action case-action" href="${attrUrl(item.caseUrl)}" target="_blank" rel="noreferrer">Åpne saken i EInnsyn ↗</a>` : '';
  const decision = item.decisionUrl ? `<a class="action case-action" href="${attrUrl(item.decisionUrl)}" target="_blank" rel="noreferrer">Åpne vedtak ↗</a>` : '';
  const attachments = documents.length ? `<details class="case-option"><summary>Vis vedlegg til saken (${documents.length})</summary><ul class="attachment-list">${documents.map((document, index) => document.url ? `<li><a href="${attrUrl(document.url)}" target="_blank" rel="noreferrer">${escapeHtml(document.title || `Vedlegg ${index + 1}`)} ↗</a></li>` : `<li>${escapeHtml(document.title || `Vedlegg ${index + 1}`)} <span class="attachment-unavailable">Ikke tilgjengelig</span></li>`).join('')}</ul></details>` : '';
  const actions = [caseLink, decision].filter(Boolean).join('');
  const metadata = renderCaseMetadata(item.metadata, item.kommuneTvUrl);
  return `<li class="case-item"><details class="case-details"><summary><span class="case-heading"><span class="case-number">${escapeHtml(item.number || 'Sak')}</span><span>${escapeHtml(title)}</span></span></summary><div class="case-content">${actions ? `<div class="case-actions">${actions}</div>` : ''}${recommendation}${attachments}${metadata}</div></details></li>`;
}

function renderCaseMetadata(metadata, kommuneTvUrl) {
  if (!metadata) return kommuneTvUrl ? `<div class="case-video-only">${renderKommuneTvAction(kommuneTvUrl)}</div>` : '';
  const speakers = Array.isArray(metadata.speakers) && metadata.speakers.length ? `<div class="metadata-block"><span class="metadata-label">Hvem hadde ordet</span><ul class="person-list">${metadata.speakers.map(person => `<li><strong>${escapeHtml(person.name)}</strong>${person.party ? ` <span>(${escapeHtml(person.party)})</span>` : ''}</li>`).join('')}</ul></div>` : `<div class="metadata-empty">Ingen talerliste registrert.</div>`;
  const proposals = Array.isArray(metadata.proposals) && metadata.proposals.length ? `<div class="metadata-block"><span class="metadata-label">Forslag fremmet</span><ul class="proposal-list">${metadata.proposals.map(proposal => `<li><strong>${escapeHtml(proposal.proposerName)}</strong>${proposal.proposerParty ? ` (${escapeHtml(proposal.proposerParty)})` : ''}${proposal.onBehalfOf ? ` <span>på vegne av ${escapeHtml(proposal.onBehalfOf)}</span>` : ''}</li>`).join('')}</ul></div>` : '';
  const status = `<span class="metadata-status ${metadataStatusClass(metadata.status)}">${escapeHtml(metadataStatusLabel(metadata.status))}</span>`;
  const kommuneTvAction = kommuneTvUrl ? renderKommuneTvAction(kommuneTvUrl) : '';
  return `<div class="case-metadata"><div class="metadata-heading"><strong>Saksmetadata</strong>${status}</div>${speakers}${kommuneTvAction}${proposals}${metadata.error ? `<p class="metadata-error">Feil: ${escapeHtml(metadata.error)}</p>` : ''}</div>`;
}

function renderKommuneTvAction(url) {
  return `<div class="case-video-action"><a class="action kommune-tv-action" href="${attrUrl(url)}" target="_blank" rel="noreferrer">${icon('tv')}Se behandlingen i Kommune-TV ↗</a></div>`;
}

function metadataStatusClass(status) { return status === 'complete' ? 'complete' : status === 'partial' ? 'partial' : status === 'failed' ? 'failed' : 'unknown'; }
function metadataStatusLabel(status) { return status === 'complete' ? 'Komplett' : status === 'partial' ? 'Delvis' : status === 'failed' ? 'Feil' : 'Ikke lest'; }

function populateCommittees() {
  const committees = [...new Set(state.meetings.map(meeting => meeting.committee))].sort((a, b) => a.localeCompare(b, 'nb-NO'));
  els.committee.innerHTML = '<option value="">Alle organer</option>' + committees.map(committee => `<option value="${escapeHtml(committee)}">${escapeHtml(committee)}</option>`).join('');
}

function populateRepresentatives() {
  const representatives = new Map();
  const addPerson = person => {
    const displayName = person?.name || person?.proposerName || '';
    if (!displayName) return;
    if (person.representativeId && state.representativeLookup.byId.has(person.representativeId)) {
      const record = state.representativeLookup.byId.get(person.representativeId);
      representatives.set(record.id, record);
      return;
    }
    const key = normalizeRepresentativeName(displayName);
    if (key && !representatives.has(`raw:${key}`)) representatives.set(`raw:${key}`, { id: '', displayName, aliases: [displayName], searchNames: [displayName], party: '' });
  };
  state.meetings.forEach(meeting => {
    [...(meeting.attendance?.fixedMembers || []), ...(meeting.attendance?.deputies || [])].forEach(addPerson);
    meeting.cases.forEach(item => {
      (item.metadata?.speakers || []).forEach(addPerson);
      (item.metadata?.proposals || []).forEach(addPerson);
    });
  });
  state.representatives = [...representatives.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'nb-NO'));
}

function renderRepresentativeSuggestions(value) {
  const query = value.trim().toLocaleLowerCase('nb-NO');
  if (!query) return hideRepresentativeSuggestions();
  const matches = state.representatives.filter(representative => representative.searchNames.some(name => String(name).toLocaleLowerCase('nb-NO').startsWith(query)));
  els.representativeSuggestions.innerHTML = matches.map(representative => `<button type="button" role="option" data-representative="${escapeHtml(representative.displayName)}" data-representative-id="${escapeHtml(representative.id)}">${escapeHtml(representative.displayName)}</button>`).join('');
  els.representativeSuggestions.hidden = matches.length === 0;
}

function hideRepresentativeSuggestions() {
  els.representativeSuggestions.hidden = true;
  els.representativeSuggestions.innerHTML = '';
}

function cleanTitle(title) { return title.replace(/^Møte i\s+/i, ''); }
function publicId(value) { return value ? value.split('/').pop() : ''; }
function publicMeetingUrl(id) { return id ? (safeUrl(id) && id.includes('/moetemappe?id=') ? id : `https://einnsyn.no/moetemappe?id=${encodeURIComponent(id)}`) : ''; }
function publicCaseUrl(id) { return id ? `https://einnsyn.no/moeteregistrering?id=${encodeURIComponent(id)}` : ''; }
function agendaDocumentUrl(id) { return id && /^do_[a-z0-9]+$/i.test(String(id)) ? `https://api.einnsyn.no/dokumentobjekt/${encodeURIComponent(id)}/download` : ''; }
function protocolDocumentUrl(value) {
  const id = Array.isArray(value) ? value[0] : value;
  if (typeof id === 'string' && /^do_[a-z0-9]+$/i.test(id)) return `https://api.einnsyn.no/dokumentobjekt/${encodeURIComponent(id)}/download`;
  return safeUrl(id) ? `https://einnsyn.no/api/v2/fil?iri=${encodeURIComponent(id)}` : '';
}

async function loadKommuneTv() {
  try {
    const response = await fetch(KOMMUNE_TV_URL, { cache: 'no-store' });
    if (!response.ok) return new Map();
    const payload = await response.json();
    if (Number(payload.schemaVersion) !== 1 || payload.dataType !== 'kommune-tv-links' || !Array.isArray(payload.meetings)) return new Map();
    const entries = new Map();
    payload.meetings.forEach(item => {
      const meetingId = String(item.einnsynMeetingId || '');
      const dateCommittee = `${item.meetingDate || ''}|${item.committee || ''}`;
      if (meetingId) entries.set(meetingId, item);
      if (item.meetingDate && item.committee) entries.set(dateCommittee, item);
    });
    return entries;
  } catch {
    return new Map();
  }
}
function documentUrl(id) { return id && !String(id).startsWith('db_') && !String(id).startsWith('do_') ? safeUrl(id) : ''; }
function safeUrl(value) { return typeof value === 'string' && /^https:\/\//i.test(value) ? value : ''; }
function attrUrl(value) { return escapeHtml(safeUrl(value)); }
function decodeMeetingId(value) { try { return new URL(value).searchParams.get('id') || ''; } catch { return ''; } }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function icon(type) {
  if (type === 'pin') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/></svg>';
  if (type === 'tv') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="12" rx="2"/><path d="m8 3 4 2.5L16 3M8.5 21h7"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/></svg>';
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js?v=1.1.0').catch(() => {
      // The app remains fully usable in Safari private browsing and older browsers.
    });
  });
}
