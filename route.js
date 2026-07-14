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
  var OPEN_KEY  = 'ags_route_open_v1';

  var stops = [];
  var markers = {};   // key -> marker element, so we can show what's already added
  var known = [];     // every registered seller, used to autocomplete the address box

  function keyOf(lng, lat) { return (+lng).toFixed(6) + ',' + (+lat).toFixed(6); }

  /* Google labels a bare lat/lng as "Dropped pin", so hand it the street address
   * instead and let it geocode. Only do that when the address actually looks like
   * a street address; anything odd falls back to coordinates, which are exact even
   * if they read as a dropped pin. */
  function destOf(addr, lng, lat) {
    var a = String(addr || '').trim();
    var hasCoords = isFinite(lng) && isFinite(lat) && lng !== null && lat !== null;
    // A real street address: hand Google the text so it labels the stop properly.
    if (/^\d+\s+\S/.test(a)) {
      if (!/chicago/i.test(a)) a += ', Chicago, IL';
      return a;
    }
    // Anything odd from the feed: coordinates are exact even if they read as a pin.
    if (hasCoords) return lat + ',' + lng;
    // Typed by hand with no coordinates (e.g. "Belmont & Kedzie"): send the text.
    if (a) return /chicago/i.test(a) ? a : a + ', Chicago, IL';
    return '';
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
  var tray, fab, listEl, countEl, noteEl, emptyEl, inputEl, suggEl, badgeEl;
  var open = false;

  function loadOpen() {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch (e) { return false; }
  }
  function saveOpen() {
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) {}
  }

  function setOpen(v) {
    open = !!v;
    saveOpen();
    tray.hidden = !open;
    fab.hidden = open;
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && inputEl) { /* don't steal focus on load, only on a real click */ }
  }

  function buildTray() {
    // The launcher. Always there, even with an empty route, so someone who never
    // taps a pin can still open the tray and type an address in by hand.
    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'route-fab';
    fab.id = 'route-fab';
    fab.setAttribute('aria-label', 'Open your route');
    fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
        '<path d="M6 3.5a2.5 2.5 0 0 1 2.5 2.5c0 1.9-2.5 4.5-2.5 4.5S3.5 7.9 3.5 6A2.5 2.5 0 0 1 6 3.5Z" ' +
          'fill="none" stroke="currentColor" stroke-width="1.8"/>' +
        '<path d="M18 13.5a2.5 2.5 0 0 1 2.5 2.5c0 1.9-2.5 4.5-2.5 4.5s-2.5-2.6-2.5-4.5a2.5 2.5 0 0 1 2.5-2.5Z" ' +
          'fill="none" stroke="currentColor" stroke-width="1.8"/>' +
        '<path d="M8.5 8.5c3.2 0 3.2 7 7 7" fill="none" stroke="currentColor" ' +
          'stroke-width="1.8" stroke-dasharray="2.5 2.5" stroke-linecap="round"/>' +
      '</svg>' +
      '<span class="route-badge" id="route-badge" hidden>0</span>';
    document.body.appendChild(fab);
    fab.addEventListener('click', function () {
      setOpen(true);
      if (inputEl && !stops.length) inputEl.focus();
    });

    tray = document.createElement('div');
    tray.className = 'route-tray';
    tray.id = 'route-tray';
    tray.hidden = true;
    tray.setAttribute('aria-live', 'polite');
    tray.innerHTML =
      '<div class="route-head">' +
        '<b>Your route <span id="route-count">(0)</span></b>' +
        '<button type="button" class="route-min" id="route-min" aria-label="Minimize route">' +
          '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">' +
            '<path d="M2 7h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
          '</svg>' +
        '</button>' +
      '</div>' +
      '<p class="route-empty" id="route-empty">No stops yet. Tap a pin on the map to add one, ' +
        'or type an address below.</p>' +
      '<ol class="route-list" id="route-list"></ol>' +
      '<div class="route-add">' +
        '<div class="route-field">' +
          '<input type="text" id="route-input" placeholder="Add an address" ' +
            'autocomplete="off" role="combobox" aria-autocomplete="list" ' +
            'aria-expanded="false" aria-controls="route-sugg" ' +
            'aria-label="Add an address to your route">' +
          '<ul class="route-sugg" id="route-sugg" role="listbox" hidden></ul>' +
        '</div>' +
        '<button type="button" id="route-add-btn">Add</button>' +
      '</div>' +
      '<p class="route-note" id="route-note"></p>' +
      '<button type="button" class="route-go" id="route-go">Open route in Google Maps →</button>' +
      '<button type="button" class="route-clear" id="route-clear">Clear route</button>';
    document.body.appendChild(tray);

    listEl = tray.querySelector('#route-list');
    countEl = tray.querySelector('#route-count');
    noteEl = tray.querySelector('#route-note');
    emptyEl = tray.querySelector('#route-empty');
    inputEl = tray.querySelector('#route-input');
    suggEl = tray.querySelector('#route-sugg');
    badgeEl = fab.querySelector('#route-badge');

    tray.querySelector('#route-min').addEventListener('click', function () { setOpen(false); });
    tray.querySelector('#route-clear').addEventListener('click', function () {
      stops = []; save(); render();
    });
    tray.querySelector('#route-go').addEventListener('click', openInGoogleMaps);

    // ---- manual entry, with autocomplete over the registered sellers ----
    // Suggestions come from the seller feed already in memory, so this is instant
    // and costs nothing. Picking one attaches its real coordinates, which also lets
    // the matching pin light up as "in your route".
    var sugg = [];      // currently displayed suggestions
    var active = -1;    // keyboard highlight

    function closeSugg() {
      suggEl.hidden = true;
      suggEl.innerHTML = '';
      sugg = [];
      active = -1;
      inputEl.setAttribute('aria-expanded', 'false');
    }

    function renderSugg() {
      var q = (inputEl.value || '').trim().toLowerCase();
      if (q.length < 2) return closeSugg();

      var added = {};
      stops.forEach(function (s) { added[s.key] = true; });

      sugg = known
        .filter(function (k) { return !added[k.key] && k.addr.toLowerCase().indexOf(q) !== -1; })
        .slice(0, 6);

      if (!sugg.length) return closeSugg();

      suggEl.innerHTML = sugg.map(function (k, i) {
        return '<li role="option" id="sg-' + i + '" data-i="' + i + '"' +
               (i === active ? ' class="is-active" aria-selected="true"' : ' aria-selected="false"') +
               '><b>' + esc(k.addr) + '</b>' +
               (k.cats ? '<i>' + esc(k.cats) + '</i>' : '') + '</li>';
      }).join('');
      suggEl.hidden = false;
      inputEl.setAttribute('aria-expanded', 'true');
    }

    function choose(i) {
      var k = sugg[i];
      if (!k) return;
      add(k.key, k.addr, k.lng, k.lat);
      inputEl.value = '';
      closeSugg();
      inputEl.focus();
    }

    function addTyped() {
      // A highlighted suggestion wins; otherwise take whatever was typed.
      if (active >= 0 && sugg[active]) return choose(active);
      var v = (inputEl.value || '').trim();
      if (!v || stops.length >= MAX_STOPS) return;
      // Exact match against a registered seller? Use it, so we get real coordinates.
      var hit = known.filter(function (k) {
        return k.addr.toLowerCase() === v.toLowerCase();
      })[0];
      if (hit) add(hit.key, hit.addr, hit.lng, hit.lat);
      else addManual(v);
      inputEl.value = '';
      closeSugg();
      inputEl.focus();
    }

    inputEl.addEventListener('input', function () { active = -1; renderSugg(); });
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' && sugg.length) {
        e.preventDefault(); active = (active + 1) % sugg.length; renderSugg();
      } else if (e.key === 'ArrowUp' && sugg.length) {
        e.preventDefault(); active = (active - 1 + sugg.length) % sugg.length; renderSugg();
      } else if (e.key === 'Enter') {
        e.preventDefault(); addTyped();
      } else if (e.key === 'Escape') {
        closeSugg();
      }
    });
    suggEl.addEventListener('mousedown', function (e) {
      var li = e.target.closest('li[data-i]');
      if (!li) return;
      e.preventDefault();                       // keep focus in the input
      choose(+li.getAttribute('data-i'));
    });
    inputEl.addEventListener('blur', function () { setTimeout(closeSugg, 120); });

    tray.querySelector('#route-add-btn').addEventListener('click', addTyped);

    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('.route-remove');
      if (!b) return;
      remove(b.getAttribute('data-key'));
    });
  }

  function render() {
    if (!tray) return;
    var n = stops.length;
    countEl.textContent = '(' + n + ')';

    emptyEl.hidden = n > 0;
    listEl.hidden = n === 0;

    listEl.innerHTML = stops.map(function (s, i) {
      return '<li><span class="route-n">' + (i + 1) + '</span>' +
             '<span class="route-addr">' + esc(s.addr) + '</span>' +
             '<button type="button" class="route-remove" data-key="' + esc(s.key) +
             '" aria-label="Remove ' + esc(s.addr) + ' from route">×</button></li>';
    }).join('');

    var full = n >= MAX_STOPS;
    noteEl.textContent = full
      ? 'That is the most Google Maps will take in one route. Remove a stop to add another.'
      : 'Walking directions, starting from wherever you are.';
    noteEl.classList.toggle('is-full', full);

    tray.querySelector('#route-go').disabled = n === 0;
    tray.querySelector('#route-clear').hidden = n === 0;
    inputEl.disabled = full;

    // badge on the launcher
    badgeEl.textContent = n;
    badgeEl.hidden = n === 0;
    fab.classList.toggle('has-stops', n > 0);

    // Show which pins are already in the route.
    Object.keys(markers).forEach(function (k) {
      markers[k].classList.toggle('is-in-route', stops.some(function (s) { return s.key === k; }));
    });

    document.querySelectorAll('.popup-add').forEach(syncButton);
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
    save(); setOpen(true); render();
  }
  // A hand-typed stop has no pin and no coordinates, just text for Google to geocode.
  function addManual(text) {
    var k = 'typed:' + text.toLowerCase();
    if (stops.some(function (s) { return s.key === k; })) return;
    if (stops.length >= MAX_STOPS) return;
    stops.push({ key: k, addr: text, lng: null, lat: null });
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
      var k = keyOf(seller.coords[0], seller.coords[1]);
      markers[k] = el;
      // Pins arrive after the map loads, which is long after the saved route was
      // restored. So mark this one on the spot instead of waiting for the next
      // render, otherwise a reloaded route shows red pins for stops it already has.
      if (stops.some(function (s) { return s.key === k; })) el.classList.add('is-in-route');
      if (seller.address && !known.some(function (x) { return x.key === k; })) {
        known.push({
          key: k,
          addr: seller.address,
          lng: seller.coords[0],
          lat: seller.coords[1],
          cats: seller.categories || ''
        });
      }
    },
    refresh: render
  };

  /* On iOS the soft keyboard shrinks the visual viewport but not the layout
   * viewport, so a `position: fixed; bottom` element ends up stranded behind the
   * keyboard, off screen. visualViewport tells us how much is actually covered;
   * we feed that to CSS as --kb so the tray lifts above it. */
  function trackKeyboard() {
    var vv = window.visualViewport;
    if (!vv) return;
    function sync() {
      var covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', Math.round(covered) + 'px');
    }
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  }

  function boot() {
    load();
    buildTray();
    setOpen(loadOpen() && stops.length > 0);   // start collapsed to the circle by default
    render();
    trackKeyboard();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
