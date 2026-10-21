import { DEFAULT_THRESHOLDS, ThresholdAlerts, validateThresholds, absoluteMpuAngle, telemetryFresh } from './threshold-alerts.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API = '/api/v1';
const SVG = 'http://www.w3.org/2000/svg';
const sidebar = $('#sidebar');
const scrim = $('#scrim');
const modal = $('#modal');
const toastHost = $('#toasts');
let lastFocus = null;
let dashboardSnapshot = null;
let webAlerts = new ThresholdAlerts();
let thresholdStorageKey = null;
let serverEvents = [];
let activeRange = '24h';
let shownEvents = new Set();
let eventsInitiallyLoaded = false;
let refreshBusy = false;
let refreshAgain = false;

function page(name, updateHash = true) {
  if (!['overview', 'history', 'sites', 'settings'].includes(name)) name = 'overview';
  $$('[data-page]').forEach((element) => { element.hidden = element.dataset.page !== name; });
  $$('[data-view]').forEach((element) => {
    element.toggleAttribute('aria-current', element.dataset.view === name);
  });
  if (updateHash) history.replaceState(null, '', `#${name}`);
  closeMenu();
  scrollTo(0, 0);
}

function closeMenu() {
  sidebar.classList.remove('open');
  scrim.classList.remove('show');
  $('#menuButton').setAttribute('aria-expanded', 'false');
  $('#menuButton').setAttribute('aria-label', 'Open menu');
  document.body.style.overflow = '';
}

function toast(title, message, type = '') {
  const existing = $$('[data-key]', toastHost).find((item) => item.dataset.key === title);
  existing?.remove();
  while (toastHost.children.length > 2) toastHost.firstElementChild.remove();
  const article = document.createElement('article');
  article.className = type;
  article.dataset.key = title;
  const content = document.createElement('div');
  const heading = document.createElement('strong');
  const detail = document.createElement('small');
  const dismiss = document.createElement('button');
  heading.textContent = title;
  detail.textContent = message;
  dismiss.type = 'button';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.onclick = () => article.remove();
  content.append(heading, detail);
  article.append(content, dismiss);
  toastHost.append(article);
  setTimeout(() => article.remove(), 6500);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(8000), ...options, headers, cache: 'no-store', credentials: 'same-origin',
  });
  if (!response.ok) {
    let message = `Station service returned ${response.status}.`;
    try { message = (await response.json()).message || message; } catch { /* Use the status text. */ }
    throw new Error(message);
  }
  return response;
}

async function getJson(path) {
  return (await api(path)).json();
}

async function postJson(path, body) {
  return (await api(path, { method: 'POST', body: JSON.stringify(body) })).json();
}

function closeModal() {
  modal.hidden = true;
  $('#alertsButton').setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
  lastFocus?.focus();
}

function openModal() {
  lastFocus = document.activeElement;
  modal.hidden = false;
  $('#alertsButton').setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
  $('.modal-head button').focus();
  refreshAlerts().catch((error) => toast('Device history unavailable', error.message, 'watch'));
}

function formatTime(value, unavailable = 'Unavailable') {
  if (!value) return unavailable;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? unavailable : new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'medium',
  }).format(date);
}

function formatRelative(value) {
  if (!value) return 'No contact recorded';
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(elapsed)) return 'Unavailable';
  if (elapsed < 60) return `${elapsed} seconds ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} minutes ago`;
  return `${Math.floor(elapsed / 3600)} hours ago`;
}

function showMeasurement(element, value, unit, digits = 1, signed = false) {
  element.replaceChildren();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    element.append('—');
    const small = document.createElement('small');
    small.textContent = 'unavailable';
    element.append(small);
    return;
  }
  const rounded = Number(value.toFixed(digits));
  element.append(signed && rounded >= 0 ? `+${rounded}` : rounded.toString());
  const small = document.createElement('small');
  small.textContent = unit;
  element.append(small);
}

function sensorState(id, value) {
  const element = $(`#${id}`);
  element.textContent = value;
  element.dataset.state = value.toLowerCase().replace(/[^a-z]+/g, '-');
}

function renderDelivery(latest) {
  const fields = ['delivery-queue', 'delivery-dropped', 'delivery-retries', 'delivery-last-success'];
  const unavailable = latest ? 'Not reported by this firmware' : 'Waiting for telemetry';
  const delivery = latest?.delivery;
  if (!delivery || !Number.isInteger(delivery.event_queue_depth) ||
      !Number.isSafeInteger(delivery.event_queue_discarded) ||
      !Number.isSafeInteger(delivery.event_retry_count)) {
    fields.forEach((id) => { $(`#${id}`).textContent = unavailable; });
    $('#delivery-observed-at').textContent = latest?.received_at
      ? `Delivery counters were not present in the snapshot received ${formatTime(latest.received_at)}.`
      : 'Delivery counters are not yet available.';
    return;
  }
  $('#delivery-queue').textContent = String(delivery.event_queue_depth);
  $('#delivery-dropped').textContent = delivery.event_queue_discarded.toLocaleString();
  $('#delivery-retries').textContent = delivery.event_retry_count.toLocaleString();
  $('#delivery-last-success').textContent = Number.isSafeInteger(delivery.last_success_uptime_ms)
    ? `${Math.floor(delivery.last_success_uptime_ms / 1000).toLocaleString()} s`
    : 'No accepted upload recorded this boot';
  $('#delivery-observed-at').textContent = latest.received_at
    ? `Counters reflect the device snapshot received ${formatTime(latest.received_at)}. Queue contents are held in device RAM and may be lost on reboot.`
    : 'Delivery counters are from the latest device snapshot.';
}

function updateNetworkState(snapshot) {
  const deviceOnline = snapshot?.device?.online === true;
  const receivedAt = snapshot?.latest?.received_at;
  const isStale = snapshot?.telemetry_stale === true || !receivedAt || Date.now() - Date.parse(receivedAt) > 15_000;
  const browserOffline = navigator.onLine === false;
  let state = 'offline';
  let message = 'No telemetry has reached the server.';
  let shortMessage = 'Offline';
  if (browserOffline) {
    state = 'stale';
    message = 'This browser is offline. The timestamped data below is the last data received by the server.';
    shortMessage = 'Browser offline';
  } else if (!deviceOnline) {
    state = 'offline';
    message = 'The station has not contacted the server recently. Readings are not live.';
    shortMessage = 'Station offline';
  } else if (isStale) {
    state = 'stale';
    message = 'The device is reachable, but its last sensor observation is more than 15 seconds old.';
    shortMessage = 'Readings stale';
  } else {
    state = 'current';
    message = `Receiving device data. Last contact ${formatRelative(snapshot.device.last_seen_at)}.`;
    shortMessage = 'Receiving data';
  }
  $('#live-banner').dataset.state = state;
  $('#live-banner').textContent = message;
  $('#mobileStatus').dataset.state = state;
  $('#mobileStatus').textContent = shortMessage;
  $('#netDot').classList.toggle('off', state !== 'current');
  $('#netStatus').textContent = shortMessage;
  $('#site-status').dataset.state = state;
  $('#site-status').textContent = state === 'current' ? 'Contacting server' : shortMessage;
}

function renderOverview(snapshot) {
  dashboardSnapshot = snapshot;
  loadBrowserThresholds(snapshot.device?.id);
  const notices = webAlerts.update(snapshot);
  for (const record of notices) toast(`${record.event.severity} · ${record.event.sensor}`, `${record.event.value} measured · ${record.event.threshold} threshold`, 'watch');
  renderBrowserAlertState();
  updateNetworkState(snapshot);
  const device = snapshot.device || {};
  const latest = snapshot.latest;
  $('#station-location').textContent = `Monitoring station · ${device.id || 'unconfigured'}`;
  $('#site-device-id').textContent = device.id || 'Unconfigured';
  $('#site-last-seen').textContent = device.last_seen_at
    ? `${formatRelative(device.last_seen_at)} · ${formatTime(device.last_seen_at)}` : 'No contact recorded';
  $('#last-updated').textContent = latest ? formatTime(latest.received_at) : 'Waiting for first upload';
  $('#last-observed').textContent = latest
    ? `Device observation: ${formatTime(latest.observed_at, `uptime ${Math.floor(latest.observed_uptime_ms / 1000)} s`)}`
    : 'Observation time unavailable';
  renderDelivery(latest);

  if (!latest) {
    ['soil-state','tilt-state','rain-state','air-state'].forEach((id) => sensorState(id, 'Unavailable'));
    showMeasurement($('#soil-reading'), null, 'ADC');
    showMeasurement($('#pitch-reading'), null, '\u00b0');
    showMeasurement($('#roll-reading'), null, '\u00b0');
    showMeasurement($('#rain-reading'), null, 'ADC');
    showMeasurement($('#air-temperature'), null, '\u00b0C');
    showMeasurement($('#air-humidity'), null, '% RH');
    $('#site-coordinates').textContent = 'Coordinates unavailable.';
    $('#site-gps-status').textContent = 'Unavailable';
    $('#site-satellites').textContent = 'Unavailable';
    $('#site-alert-mode').textContent = 'Waiting for telemetry';
    $('#map-empty').hidden = false;
    $('#map-empty').textContent = 'Station coordinates are not available yet.';
    $('#map-marker').hidden = true;
    return;
  }

  const readings = latest.readings || {};
  const health = latest.health || {};
  const gps = latest.gps || {};
  const fresh = telemetryFresh(snapshot);
  showMeasurement($('#soil-reading'), readings.soil_adc_raw, 'ADC', 0);
  sensorState('soil-state', !fresh ? 'Stale' : health.soil || 'Unknown');
  $('#soil-detail').textContent = readings.soil_adc_raw === null || readings.soil_adc_raw === undefined
    ? 'Raw ADC reading unavailable.' : 'Direct raw analog-to-digital sensor count.';

  showMeasurement($('#pitch-reading'), readings.pitch_deg, '\u00b0', 0, true);
  showMeasurement($('#roll-reading'), readings.roll_deg, '\u00b0', 0, true);
  sensorState('tilt-state', !fresh ? 'Stale' : health.mpu || 'Unknown');
  const angle = absoluteMpuAngle(readings);
  $('#tilt-detail').textContent = angle === null ? 'Waiting for valid pitch and roll.' : `Alert angle ${angle.toFixed(1)}° = max(|pitch|, |roll|). No baseline or test mode required.`;

  showMeasurement($('#rain-reading'), readings.rain_adc_raw, 'ADC', 0);
  sensorState('rain-state', !fresh ? 'Stale' : health.rain || 'Unknown');
  $('#rain-detail').textContent = readings.rain_adc_raw === null || readings.rain_adc_raw === undefined
    ? 'Raw rain-plate ADC reading unavailable.' : 'Direct raw analog-to-digital sensor count.';

  showMeasurement($('#air-temperature'), readings.temperature_c, '\u00b0C', 0);
  showMeasurement($('#air-humidity'), readings.humidity_pct, '% RH', 0);
  sensorState('air-state', !fresh ? 'Stale' : health.dht11 || 'Unknown');
  $('#air-detail').textContent = 'Temperature and humidity from the DHT11 sensor.';

  $('#site-alert-mode').textContent = fresh ? 'Automatic in this browser' : 'Paused · readings stale';
  $('#site-gps-status').textContent = gps.status || 'Unavailable';
  $('#site-satellites').textContent = Number.isInteger(gps.satellites) && gps.satellites >= 0
    ? String(gps.satellites) : 'Unavailable';
  if (typeof gps.latitude === 'number' && typeof gps.longitude === 'number' && gps.status !== 'UNAVAILABLE') {
    $('#site-coordinates').textContent = `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)} · ${gps.status} · monitoring station`;
    $('#map-empty').hidden = true;
    $('#map-marker').hidden = false;
    $('#map-marker').href = `https://www.google.com/maps?q=${encodeURIComponent(`${gps.latitude},${gps.longitude}`)}`;
    $('#map-marker').setAttribute('aria-label', `Open station coordinates ${gps.latitude.toFixed(4)}, ${gps.longitude.toFixed(4)} in maps`);
  } else {
    $('#site-coordinates').textContent = 'Coordinates unavailable.';
    $('#map-empty').hidden = false;
    $('#map-empty').textContent = 'Station coordinates are not available yet.';
    $('#map-marker').hidden = true;
  }
}

function timeRange(readings, key) {
  const values = readings.map((row) => ({ at: row.received_at, value: key(row) }))
    .filter((sample) => Number.isFinite(sample.value) && sample.at);
  if (!values.length) return 'No valid samples in this period.';
  const low = Math.min(...values.map((sample) => sample.value));
  const high = Math.max(...values.map((sample) => sample.value));
  return `${values.length} samples · ${low.toFixed(1)}–${high.toFixed(1)} · ${formatTime(values[0].at, '')} to ${formatTime(values.at(-1).at, '')}`;
}

function renderTrend(svgId, rangeId, rows, pick, colour) {
  const svg = $(`#${svgId}`);
  svg.replaceChildren();
  for (const y of [12, 34, 56, 78]) {
    const grid = document.createElementNS(SVG, 'line');
    grid.setAttribute('x1', '0'); grid.setAttribute('x2', '300');
    grid.setAttribute('y1', String(y)); grid.setAttribute('y2', String(y));
    grid.setAttribute('stroke', '#e4ebe7'); grid.setAttribute('stroke-width', '1');
    svg.append(grid);
  }
  const series = rows.map((row, index) => ({ index, value: pick(row) }));
  const values = series.map((sample) => sample.value).filter(Number.isFinite);
  if (!values.length) {
    $('#'+rangeId).textContent = 'No valid samples in this period.';
    return;
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = Math.max(0.1, maximum - minimum);
  const paths = [];
  let current = [];
  for (const sample of series) {
    if (!Number.isFinite(sample.value)) {
      if (current.length) paths.push(current);
      current = [];
      continue;
    }
    const denominator = Math.max(1, series.length - 1);
    current.push(`${(sample.index / denominator * 292 + 4).toFixed(1)},${(80 - (sample.value - minimum) / span * 66).toFixed(1)}`);
  }
  if (current.length) paths.push(current);
  for (const coordinates of paths) {
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('points', coordinates.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', colour);
    line.setAttribute('stroke-width', '2.5');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.append(line);
  }
  $('#'+rangeId).textContent = timeRange(rows, pick);
}

function readingsRangeUrl(range) { return `/readings?range=${encodeURIComponent(range)}&limit=500`; }

function renderChart(readings) {
  const rows = readings || [];
  renderTrend('soil-chart', 'soil-chart-range', rows,
    (row) => row.health?.soil === 'ONLINE' ? row.readings?.soil_adc_raw : null, '#a96c00');
  renderTrend('tilt-chart', 'tilt-chart-range', rows,
    (row) => row.health?.mpu === 'ONLINE' ? absoluteMpuAngle(row.readings) : null, '#1c8b4b');
  renderTrend('air-chart', 'air-chart-range', rows,
    (row) => row.readings?.temperature_c, '#df454b');
}

function textCell(value) { return value === null || value === undefined ? '—' : String(value); }

function renderHistory(readings) {
  const body = $('#history-rows');
  const labels = ['Received', 'Observed', 'Soil ADC / wetness', 'Rain ADC / plate wetness', 'MPU alert angle', 'Temperature', 'Device health'];
  body.replaceChildren();
  const rows = [...(readings || [])].reverse().slice(0, 100);
  $('#history-status').textContent = rows.length
    ? `Showing ${rows.length} of up to 500 readings stored for the selected period.`
    : 'No sensor readings have been recorded for this period.';
  if (!rows.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 7; cell.textContent = 'No readings have arrived.'; row.append(cell); body.append(row); return;
  }
  for (const sample of rows) {
    const row = document.createElement('tr');
    const readings = sample.readings || {}; const health = sample.health || {};
    const values = [formatTime(sample.received_at), formatTime(sample.observed_at,
      `uptime ${Math.floor((sample.observed_uptime_ms || 0) / 1000)} s`),
    `${textCell(readings.soil_adc_raw)} ADC / ${textCell(readings.soil_wetness_pct)}%`,
    `${textCell(readings.rain_adc_raw)} ADC / ${textCell(readings.rain_wetness_pct)}%`,
    health.mpu === 'ONLINE' && absoluteMpuAngle(readings) !== null ? `${absoluteMpuAngle(readings).toFixed(2)}°` : '—',
    readings.temperature_c == null ? '—' : `${Number(readings.temperature_c).toFixed(1)}°C`,
    `MPU ${textCell(health.mpu)} · Soil ${textCell(health.soil)} · Rain ${textCell(health.rain)} · DHT11 ${textCell(health.dht11)}`];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.dataset.label = labels[index];
      cell.textContent = value;
      row.append(cell);
    });
    body.append(row);
  }
}

function makeButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className; button.textContent = label;
  button.onclick = handler;
  return button;
}

function renderAlerts(alerts) {
  const holder = $('#alert-list'); holder.replaceChildren();
  if (alerts) serverEvents = alerts;
  const events = [...webAlerts.events, ...serverEvents].sort((a, b) => Date.parse(b.occurred_at || b.received_at) - Date.parse(a.occurred_at || a.received_at));
  const activeCount = events.filter((event) => !event.event?.resolved).length;
  const badge = $('#alertCount');
  badge.hidden = activeCount === 0;
  badge.textContent = String(activeCount);
  if (!events.length) { holder.textContent = 'No browser or device events have been recorded.'; return; }
  for (const event of events) {
    const card = document.createElement('article');
    const time = document.createElement('time');
    const content = document.createElement('div');
    const title = document.createElement('strong');
    const details = document.createElement('p');
    const status = document.createElement('span');
    time.dateTime = event.occurred_at || event.received_at || '';
    time.textContent = formatTime(event.occurred_at || event.received_at,
      `uptime ${event.observed_uptime_s || 0} s`);
    title.textContent = `${event.source === 'browser' ? 'BROWSER · ' : 'DEVICE · '}${event.event?.simulated ? 'SIMULATED · ' : ''}${event.event?.severity || 'EVENT'} · ${event.event?.sensor || 'sensor'}`;
    details.textContent = `${event.event?.value ?? '—'} measured · ${event.event?.threshold ?? '—'} threshold · ${event.event?.duration_s ?? '—'} seconds · GPS ${event.event?.gps_status || 'UNAVAILABLE'} · ${event.event?.resolved ? 'resolved' : 'active'}`;
    if (event.source === 'browser') details.textContent = `${event.event.value}${event.event.sensor === 'MPU_ANGLE' ? '°' : ' ADC'} ${event.event.direction === 'below' ? '≤' : '≥'} ${event.event.threshold} threshold · ${event.event.resolved ? 'closed: ' + event.event.reason : event.event.stale ? 'STALE: current condition unknown' : 'active'}`;
    status.className = `tag ${event.event?.resolved ? '' : 'watch'}`;
    status.textContent = event.acknowledged ? `Acknowledged${event.acknowledged_by ? ` by ${event.acknowledged_by}` : ''}` : 'Not acknowledged';
    content.append(title, details, status);
    if (!event.acknowledged) {
      content.append(makeButton('Acknowledge', 'secondary ack-button', async () => {
        try {
          if (event.source === 'browser') { event.acknowledged = true; renderAlerts(); return; }
          await postJson('/alerts/ack', { event_id: event.event_id });
          toast('Event acknowledged', 'The sensor condition keeps its current state.');
          await refreshAlerts();
        } catch (error) { toast('Acknowledgment failed', error.message, 'watch'); }
      }));
    }
    if (event.event?.latitude != null && event.event?.longitude != null && event.event?.gps_status !== 'UNAVAILABLE') {
      const coordinates = document.createElement('small');
      coordinates.textContent = `Monitoring station · ${event.event.latitude.toFixed(6)}, ${event.event.longitude.toFixed(6)} · fix age ${event.event.fix_age_s ?? 'unknown'} s`;
      content.append(coordinates);
    }
    card.append(time, content); holder.append(card);
    const eventKey = `${event.event_id}:${event.revision}`;
    if (event.source !== 'browser' && eventsInitiallyLoaded && !shownEvents.has(eventKey)) {
      toast(`New experimental ${event.event?.severity || 'sensor'} event`, `${event.event?.sensor || 'Station'} · ${event.event?.resolved ? 'resolved' : 'active'}`, 'watch');
    }
    if (event.source !== 'browser') shownEvents.add(eventKey);
  }
  shownEvents = new Set(serverEvents.map((event) => `${event.event_id}:${event.revision}`));
  if (alerts !== undefined) eventsInitiallyLoaded = true;
}

async function refreshAlerts() {
  renderAlerts();
  const result = await getJson('/alerts?limit=100');
  renderAlerts(result.alerts);
}

function populateThresholds() {
  const cfg = webAlerts.config;
  $('#mpu-enabled').checked = cfg.mpu.enabled;
  for (const level of ['caution', 'warning', 'critical']) $(`#${level}`).value = cfg.mpu[level];
  for (const sensor of ['soil', 'rain']) {
    $(`#${sensor}-threshold`).value = cfg[sensor].threshold;
    $(`#${sensor}-direction`).value = cfg[sensor].direction;
    $(`#${sensor}-enabled`).checked = cfg[sensor].enabled;
  }
}

function loadBrowserThresholds(deviceId) {
  if (!deviceId) return;
  const key = `slide.browser-thresholds.v1:${deviceId}`;
  if (key === thresholdStorageKey) return;
  thresholdStorageKey = key;
  let config = DEFAULT_THRESHOLDS;
  try {
    const saved = localStorage.getItem(key);
    if (saved) config = validateThresholds(JSON.parse(saved));
    $('#threshold-feedback').textContent = 'Thresholds are saved in this browser for this station.';
  } catch {
    $('#threshold-feedback').textContent = 'Saved thresholds unavailable. Using editable defaults.';
  }
  webAlerts = new ThresholdAlerts(config);
  populateThresholds();
}

function renderBrowserAlertState() {
  const banner = $('#threshold-banner');
  const active = [...webAlerts.active.values()];
  const missing = Object.keys(webAlerts.values).filter((key) => webAlerts.config[key].enabled && webAlerts.values[key] === null);
  banner.dataset.state = active.some((record) => record.event.severity === 'CRITICAL') ? 'offline' : active.length || missing.length ? 'stale' : 'current';
  banner.textContent = active.length ? active.map((record) => `${record.event.severity} · ${record.event.sensor}: ${record.event.value}${record.event.sensor === 'MPU_ANGLE' ? '°' : ' ADC'}${record.event.stale ? ' · STALE: current condition unknown' : ''}`).join(' | ') :
    missing.length ? `Browser alerts paused for unavailable readings: ${missing.join(', ')}.` : 'Automatic browser alerts active. No thresholds currently exceeded.';
  if (active.length && missing.length) banner.textContent += ` | Awaiting fresh readings: ${missing.join(', ')}.`;
  renderAlerts();
}

function saveBrowserThresholds() {
  const field = (id) => $(`#${id}`).value.trim() === '' ? NaN : Number($(`#${id}`).value);
  try {
    if (!thresholdStorageKey) throw new Error('Wait for the station identity before saving thresholds.');
    const config = validateThresholds({
      mpu: { enabled: $('#mpu-enabled').checked, caution: field('caution'), warning: field('warning'), critical: field('critical') },
      ...Object.fromEntries(['soil', 'rain'].map((sensor) => [sensor, {
        enabled: $(`#${sensor}-enabled`).checked, threshold: field(`${sensor}-threshold`), direction: $(`#${sensor}-direction`).value,
      }])),
    });
    webAlerts.configure(config);
    let saved = true;
    try { localStorage.setItem(thresholdStorageKey, JSON.stringify(config)); } catch { saved = false; }
    $('#threshold-feedback').textContent = saved ? 'Alert thresholds saved in this browser.' : 'Thresholds active for this tab; browser storage is unavailable.';
    const notices = webAlerts.update(dashboardSnapshot);
    for (const record of notices) toast(`${record.event.severity} · ${record.event.sensor}`, 'Current reading exceeds the updated threshold.', 'watch');
    renderBrowserAlertState();
  } catch (error) { $('#threshold-feedback').textContent = error.message; }
}

async function refresh() {
  if (refreshBusy) { refreshAgain = true; return; }
  refreshBusy = true;
  try {
    const snapshot = await getJson('/dashboard');
    renderOverview(snapshot);
    // Secondary history failures must not stop alerts from fresh live telemetry.
    await Promise.allSettled([
      getJson(readingsRangeUrl(activeRange)).then((history) => { renderChart(history.readings); renderHistory(history.readings); })
        .catch(() => { $('#history-status').textContent = 'Stored reading history is temporarily unavailable.'; }),
      refreshAlerts().catch(() => { /* Browser alerts remain available independently of device event history. */ }),
    ]);
  } catch (error) {
    webAlerts.markStale(); renderBrowserAlertState();
    $('#live-banner').dataset.state = 'offline';
    $('#live-banner').textContent = `Station service unavailable: ${error.message}`;
    $('#mobileStatus').dataset.state = 'offline';
    $('#mobileStatus').textContent = 'Service unavailable';
    $('#netDot').classList.add('off');
    $('#netStatus').textContent = 'Service unavailable';
  } finally {
    refreshBusy = false;
    if (refreshAgain) { refreshAgain = false; queueMicrotask(refresh); }
  }
}

function bindControls() {
  $('#menuButton').onclick = () => {
    sidebar.classList.add('open'); scrim.classList.add('show');
    $('#menuButton').setAttribute('aria-expanded', 'true');
    $('#menuButton').setAttribute('aria-label', 'Close menu');
    document.body.style.overflow = 'hidden';
  };
  $('#collapseButton').onclick = () => {
    const collapsed = document.documentElement.classList.toggle('collapsed');
    $('#collapseButton').setAttribute('aria-expanded', String(!collapsed));
    $('#collapseButton').setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
    try { localStorage.setItem('slide-collapse', document.documentElement.classList.contains('collapsed')); } catch { /* Sidebar preference is optional. */ }
  };
  try {
    const collapsed = localStorage.getItem('slide-collapse') === 'true';
    document.documentElement.classList.toggle('collapsed', collapsed);
    $('#collapseButton').setAttribute('aria-expanded', String(!collapsed));
    $('#collapseButton').setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
  } catch { /* Browser storage may be disabled. */ }
  scrim.onclick = closeMenu;
  $$('[data-view]').forEach((element) => element.addEventListener('click', (event) => {
    event.preventDefault(); page(element.dataset.view);
  }));
  addEventListener('hashchange', () => page(location.hash.slice(1), false));
  page(location.hash.slice(1) || 'overview', false);
  $('#alertsButton').onclick = openModal;
  $$('[data-close]').forEach((element) => { element.onclick = closeModal; });
  addEventListener('keydown', (event) => { if (event.key === 'Escape') modal.hidden ? closeMenu() : closeModal(); });
  $$('.periods button').forEach((button) => button.addEventListener('click', () => {
    $$('.periods button').forEach((item) => { item.classList.remove('active'); item.setAttribute('aria-pressed', 'false'); });
    button.classList.add('active'); button.setAttribute('aria-pressed', 'true');
    activeRange = button.dataset.range; $('#historyRange').value = activeRange; refresh();
  }));
  $('#historyRange').onchange = (event) => { activeRange = event.target.value; refresh(); };
  $('#save-thresholds').onclick = saveBrowserThresholds;
  $('#exportCsv').onclick = async (event) => {
    event.preventDefault();
    try {
      const response = await api(`/readings.csv?range=${encodeURIComponent(activeRange)}&limit=500`);
      const blob = await response.blob(); const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = 'slide-readings.csv';
      link.click(); URL.revokeObjectURL(link.href);
    } catch (error) { toast('Export unavailable', error.message, 'watch'); }
  };
  addEventListener('online', () => { if (dashboardSnapshot) updateNetworkState(dashboardSnapshot); refresh(); });
  addEventListener('offline', () => { webAlerts.markStale(); renderBrowserAlertState(); if (dashboardSnapshot) updateNetworkState(dashboardSnapshot); });
  addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

populateThresholds();
renderBrowserAlertState();
bindControls();
if ('serviceWorker' in navigator) addEventListener('load', () => {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
});
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2500);

setInterval(() => {
  if (navigator.onLine === false || !telemetryFresh(dashboardSnapshot)) {
    webAlerts.markStale(); renderBrowserAlertState();
    if (dashboardSnapshot) updateNetworkState(dashboardSnapshot);
  }
}, 1000);
