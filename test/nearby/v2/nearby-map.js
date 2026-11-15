/* Live screen data only: no place cache, persistence, or analytics. */
(function () {
  'use strict';
  var map, places, clusterer, selectedOverlay, locationOverlay, overlays = [], searchGeneration = 0, areaGeneration = 0, initializing = false;
  var stableCenter, mapWidth, mapHeight;
  function relayout() {
    var element = document.getElementById('map');
    mapWidth = element.clientWidth; mapHeight = element.clientHeight;
    map.relayout(); map.setCenter(stableCenter);
  }
  function emit(message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
    else if (window.parent !== window) window.parent.postMessage(message, window.location.origin);
  }
  function validPoint(p) {
    return p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
  }
  function initialize(key) {
    if (map) { emit({ type: 'ready' }); return; }
    if (initializing || typeof key !== 'string' || !/^[a-zA-Z0-9]{16,100}$/.test(key)) return;
    initializing = true;
    var script = document.createElement('script');
    script.src = 'https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&libraries=services,clusterer&appkey=' + encodeURIComponent(key);
    script.onerror = function () { emit({ type: 'error' }); };
    script.onload = function () {
      if (!window.kakao || !window.kakao.maps) { emit({ type: 'error' }); return; }
      window.kakao.maps.load(function () {
        try {
          map = new kakao.maps.Map(document.getElementById('map'), { center: new kakao.maps.LatLng(37.5665, 126.978), level: 5 });
          stableCenter = map.getCenter();
          mapWidth = document.getElementById('map').clientWidth; mapHeight = document.getElementById('map').clientHeight;
          places = new kakao.maps.services.Places();
          clusterer = new kakao.maps.MarkerClusterer({ map: map, averageCenter: true, minLevel: 2, gridSize: 52,
            styles: [{ width: '34px', height: '34px', lineHeight: '34px', borderRadius: '50%',
              background: '#087f6b', color: '#fff', textAlign: 'center', fontWeight: '700',
              border: '3px solid #fff', boxShadow: '0 2px 8px #0002' }] });
          kakao.maps.event.addListener(map, 'idle', function () {
            var element = document.getElementById('map');
            if (element.clientWidth !== mapWidth || element.clientHeight !== mapHeight) { relayout(); return; }
            var p = map.getCenter();
            stableCenter = p;
            emit({ type: 'center', point: { latitude: p.getLat(), longitude: p.getLng() } });
          });
          window.addEventListener('resize', relayout);
          if (window.ResizeObserver) new window.ResizeObserver(relayout).observe(document.getElementById('map'));
          emit({ type: 'ready' });
        } catch (error) { emit({ type: 'error' }); }
      });
    };
    document.head.appendChild(script);
  }
  function query(keyword, options) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { finish({ failed: true, rows: [], hasNext: false }); }, 10000);
      function finish(result) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(result);
      }
      try {
        places.keywordSearch(keyword, function (rows, status, pagination) {
          finish({ rows: status === kakao.maps.services.Status.OK ? rows : [],
            failed: status !== kakao.maps.services.Status.OK && status !== kakao.maps.services.Status.ZERO_RESULT,
            hasNext: !!(pagination && pagination.hasNext) });
        }, options);
      } catch (error) { finish({ failed: true, rows: [], hasNext: false }); }
    });
  }
  function pause() { return new Promise(function (resolve) { setTimeout(resolve, 150); }); }
  async function search(command) {
    var generation = ++searchGeneration;
    var rows = [], failed = [], truncated = false;
    var brands = Array.from(new Set(command.brands.filter(function (b) { return typeof b === 'string' && b.length > 0 && b.length <= 100; })));
    for (var index = 0; index < brands.length; index++) {
      for (var page = 1; page <= 3; page++) {
        if (generation !== searchGeneration) return;
        var result = await query(brands[index], { x: command.point.longitude, y: command.point.latitude,
          radius: command.radius, sort: kakao.maps.services.SortBy.DISTANCE, size: 15, page: page });
        if (generation !== searchGeneration) return;
        if (result.failed) { failed.push(brands[index]); break; }
        result.rows.forEach(function (p) {
          var point = { latitude: Number(p.y), longitude: Number(p.x) };
          if (!validPoint(point)) return;
          rows.push({ id: String(p.id), name: String(p.place_name), address: String(p.road_address_name || p.address_name),
            category: String(p.category_name || ''), point: point, brand: brands[index] });
        });
        if (!result.hasNext) break;
        if (page === 3) { truncated = true; break; }
        await pause();
      }
      emit({ type: 'progress', requestId: command.requestId, completed: index + 1, total: brands.length });
      await pause();
    }
    if (generation === searchGeneration) emit({ type: 'results', requestId: command.requestId, places: rows, failedBrands: failed, truncated: truncated });
  }
  async function searchArea(command) {
    var generation = ++areaGeneration;
    var result = await query(command.query, { size: 5 });
    if (generation !== areaGeneration) return;
    emit({ type: 'areas', requestId: command.requestId, failed: result.failed,
      areas: result.rows.map(function (p) { return { id: String(p.id), name: String(p.place_name),
        address: String(p.road_address_name || p.address_name), point: { latitude: Number(p.y), longitude: Number(p.x) } }; }) });
  }
  function drawMarkers(command) {
    clusterer.clear();
    if (selectedOverlay) { selectedOverlay.setMap(null); selectedOverlay = null; }
    overlays.forEach(function (overlay) { overlay.setMap(null); }); overlays = [];
    command.places.forEach(function (p) {
      if (!validPoint(p.point)) return;
      var button = document.createElement('button');
      button.type = 'button'; button.textContent = p.brand;
      button.setAttribute('data-brand', p.brand);
      button.setAttribute('aria-label', p.name + ' 브랜드 혜택 보기');
      button.setAttribute('aria-pressed', String(p.id === command.selectedId));
      button.addEventListener('click', function () { emit({ type: 'select', id: p.id }); });
      var overlay = new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(p.point.latitude, p.point.longitude),
        content: button, yAnchor: 1, zIndex: p.id === command.selectedId ? 2 : 1 });
      // Keep the chosen store visible even when surrounding stores are clustered.
      if (p.id === command.selectedId) { selectedOverlay = overlay; overlay.setMap(map); }
      else overlays.push(overlay);
    });
    clusterer.addMarkers(overlays);
  }
  function receive(command) {
    if (!command || typeof command !== 'object') return;
    if (command.type === 'init') { initialize(command.key); return; }
    if (!map) return;
    if (command.type === 'relayout') { relayout(); return; }
    if (command.type === 'location') {
      if (locationOverlay) { locationOverlay.setMap(null); locationOverlay = null; }
      if (validPoint(command.point)) {
        var dot = document.createElement('div');
        dot.className = 'current-location'; dot.setAttribute('aria-label', '내 위치');
        locationOverlay = new kakao.maps.CustomOverlay({ map: map,
          position: new kakao.maps.LatLng(command.point.latitude, command.point.longitude), content: dot, zIndex: 0 });
      }
      return;
    }
    if (command.type === 'cancel') { searchGeneration++; areaGeneration++; return; }
    if (command.type === 'center' && validPoint(command.point)) {
      stableCenter = new kakao.maps.LatLng(command.point.latitude, command.point.longitude);
      map.setCenter(stableCenter);
    }
    if (command.type === 'markers' && Array.isArray(command.places)) drawMarkers(command);
    if (!Number.isSafeInteger(command.requestId) || command.requestId < 1) return;
    if (command.type === 'area' && typeof command.query === 'string' && command.query.length <= 100) searchArea(command);
    if (command.type === 'search' && Array.isArray(command.brands) && command.brands.length <= 200
      && validPoint(command.point) && [1000, 3000, 5000].includes(command.radius)) search(command);
  }
  window.modeuiMap = { receive: receive };
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    receive(event.data);
  });
})();
