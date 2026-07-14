/* Avondale Garage Sale — route builder.
 * Shared by every page that shows the map. Handles:
 *   - the popup markup (address, hours, categories, and the two actions)
 *   - the "Add to route" tray that collects stops
 *   - handing the finished route off to Google Maps
 *
 * Google's Maps URL API takes an origin, a destination, and up to 9 waypoints
 * in between, so a route tops out at 10 stops. We enforce that in the UI rather
 * than letting Google silently drop the overflow.
 */
(function () {
  var MAX_STOPS = 10;
  var STORE_KEY = 'ags_route_v1';

  var stops = [];
  var markers = {};   // key -> marker element, so we can show what's already added

  function keyOf(lng, lat) { return (+lng).toFixed(6) + ',' + (+lat).toFixed(6); }

  /* Google labels a bare lat/lng as "Dropped pin", so hand it the street address
   * instead and let it geocode. Only do that when the address actually looks like
   * a street address; anything odd falls back to coordinates, which are exact even
   * if they read as a dropped pin. */
  function destOf(addr, lng, lat) {
    var a = String(addr || '').trim();
    if (/^\d+\s+\S/.test(a)) {
      if (!/chicago/i.test(a)) a += ', Chicago, IL';
      return a;
    }
    return lat + ',' + lng;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- storage: the route survives moving between pages ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      stops = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(stops)) stops = [];
    } catch (e) { stops = []; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(stops)); } catch (e) {}
  }

  /* ---------- popup markup ---------- */
  function popupHtml(seller) {
    var lng = seller.coords[0], lat = seller.coords[1];
    var k = keyOf(lng, lat);
    var addr = seller.address || 'Registered seller';
    var hours = seller.hours || '';
    var cats = seller.categories || '';

    // Single-stop directions, walking, straight to the house.
    var dir = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=' +
              encodeURIComponent(destOf(addr, lng, lat));

    return '' +
      '<strong>' + esc(addr) + '</strong>' +
      (hours ? '<span class="popup-hours">' + esc(hours) + '</span>' : '') +
      (cats ? '<span class="popup-cats">' + esc(cats) + '</span>' : '') +
      '<span class="popup-actions">' +
        '<button type="button" class="popup-add" data-key="' + k + '"' +
          ' data-lng="' + lng + '" data-lat="' + lat + '"' +
          ' data-addr="' + esc(addr) + '">+ Add to route</button>' +
        '<a class="popup-dir" href="' + dir + '" target="_blank" rel="noopener">Directions</a>' +
      '</span>';
  }

  /* ---------- tray ---------- */
  var tray, listEl, countEl, goEl, noteEl;

  function buildTray() {
    tray = document.createElement('div');
    tray.className = 'route-tray';
    tray.id = 'route-tray';
    tray.hidden = true;
    tray.setAttribute('aria-live', 'polite');
    tray.innerHTML =
      '<div class="route-head">' +
        '<b>Your route <span id="route-count">0</span></b>' +
        '<button type="button" class="route-clear" id="route-clear">Clear</button>' +
      '</div>' +
      '<ol class="route-list" id="route-list"></ol>' +
      '<p class="route-note" id="route-note"></p>' +
      '<button type="button" class="route-go" id="route-go">Open route in Google Maps →</button>';
    document.body.appendChild(tray);

    listEl = tray.querySelector('#route-list');
    countEl = tray.querySelector('#route-count');
    goEl = tray.querySelector('#route-go');
    noteEl = tray.querySelector('#route-note');

    tray.querySelector('#route-clear').addEventListener('click', function () {
      stops = []; save(); render();
    });
    goEl.addEventListener('click', openInGoogleMaps);

    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('.route-remove');
      if (!b) return;
      remove(b.getAttribute('data-key'));
    });
  }

  function render() {
    if (!tray) return;
    countEl.textContent = '(' + stops.length + ')';
    tray.hidden = stops.length === 0;

    listEl.innerHTML = stops.map(function (s, i) {
      return '<li><span class="route-n">' + (i + 1) + '</span>' +
             '<span class="route-addr">' + esc(s.addr) + '</span>' +
             '<button type="button" class="route-remove" data-key="' + s.key +
             '" aria-label="Remove ' + esc(s.addr) + ' from route">×</button></li>';
    }).join('');

    var full = stops.length >= MAX_STOPS;
    noteEl.textContent = full
      ? 'That is the most Google Maps will take in one route. Remove a stop to add another.'
      : 'Walking directions, starting from wherever you are.';
    noteEl.classList.toggle('is-full', full);

    // Show which pins are already in the route.
    Object.keys(markers).forEach(function (k) {
      markers[k].classList.toggle('is-in-route', stops.some(function (s) { return s.key === k; }));
    });

    // Any open popup should reflect the change too.
    document.querySelectorAll('.popup-add').forEach(function (btn) {
      syncButton(btn);
    });
  }

  function syncButton(btn) {
    var k = btn.getAttribute('data-key');
    var inRoute = stops.some(function (s) { return s.key === k; });
    btn.classList.toggle('is-added', inRoute);
    btn.textContent = inRoute ? '✓ In your route' : '+ Add to route';
    btn.disabled = !inRoute && stops.length >= MAX_STOPS;
    if (btn.disabled) btn.textContent = 'Route is full';
  }

  function add(key, addr, lng, lat) {
    if (stops.some(function (s) { return s.key === key; })) return;
    if (stops.length >= MAX_STOPS) return;
    stops.push({ key: key, addr: addr, lng: +lng, lat: +lat });
    save(); render();
  }
  function remove(key) {
    stops = stops.filter(function (s) { return s.key !== key; });
    save(); render();
  }

  /* ---------- hand off to Google Maps ---------- */
  function openInGoogleMaps() {
    if (!stops.length) return;
    var pts = stops.map(function (s) { return destOf(s.addr, s.lng, s.lat); });

    // Origin is left off on purpose: Google then starts from the user's own
    // location, which is what someone standing on the street actually wants.
    var dest = pts[pts.length - 1];
    var mid = pts.slice(0, -1);

    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=walking' +
              '&destination=' + encodeURIComponent(dest) +
              (mid.length ? '&waypoints=' + encodeURIComponent(mid.join('|')) : '');
    window.open(url, '_blank', 'noopener');
  }

  /* ---------- wiring ---------- */
  // Popups are created and destroyed by Mapbox, so listen on the document
  // instead of binding to buttons that may not exist yet.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.popup-add');
    if (!btn || btn.disabled) return;
    var k = btn.getAttribute('data-key');
    if (stops.some(function (s) { return s.key === k; })) {
      remove(k);            // tapping again takes it back out
    } else {
      add(k, btn.getAttribute('data-addr'), btn.getAttribute('data-lng'), btn.getAttribute('data-lat'));
    }
    syncButton(btn);
  });

  window.SaleRoute = {
    popupHtml: popupHtml,
    // Pages hand their pins over so the tray can highlight the ones already added.
    registerMarker: function (seller, el) {
      markers[keyOf(seller.coords[0], seller.coords[1])] = el;
    },
    refresh: render
  };

  function boot() { load(); buildTray(); render(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
