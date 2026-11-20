/* Live screen data only: no place cache, persistence, or analytics. */
(function () {
  'use strict';
  var map, places, clusterer, selectedOverlay, locationOverlay, overlays = [], searchGeneration = 0, areaGeneration = 0, initializing = false;
  var stableCenter, mapWidth, mapHeight, mapInteraction = false;
  var overlayIds = new Map();
  // Only the currently displayed search lives here; no cross-search cache or persistence.
  var activeSearch, activeQueries = 0, queryQueue = [];
  function relayout() {
    var element = document.getElementById('map');
    mapWidth = element.clientWidth; mapHeight = element.clientHeight;
    map.relayout();
    map.setCenter(stableCenter);
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
          kakao.maps.event.addListener(map, 'click', function () { emit({ type: 'map-tap' }); });
          kakao.maps.event.addListener(map, 'dragstart', function () { mapInteraction = true; });
          kakao.maps.event.addListener(map, 'zoom_start', function () { mapInteraction = true; });
          mapWidth = document.getElementById('map').clientWidth; mapHeight = document.getElementById('map').clientHeight;
          places = new kakao.maps.services.Places();
          clusterer = new kakao.maps.MarkerClusterer({ map: map, averageCenter: true, minLevel: 2, gridSize: 52, disableClickZoom: true,
            styles: [{ width: '34px', height: '34px', lineHeight: '34px', borderRadius: '50%',
              background: '#087f6b', color: '#fff', textAlign: 'center', fontWeight: '700',
              border: '3px solid #fff', boxShadow: '0 2px 8px #0002' }] });
          kakao.maps.event.addListener(clusterer, 'clusterclick', function (cluster) {
            var ids = cluster.getMarkers().map(function (marker) { return overlayIds.get(marker); }).filter(Boolean);
            if (!ids.length) return;
            kakao.maps.event.preventMap();
            // Snapshot the clicked group before zooming reclusters the map.
            stableCenter = cluster.getCenter();
            map.setCenter(stableCenter);
            if (ids.length >= 30 && map.getLevel() > 2) map.setLevel(map.getLevel() - 1);
            mapInteraction = false;
            emit({ type: 'center', point: { latitude: stableCenter.getLat(), longitude: stableCenter.getLng() } });
            emit({ type: 'cluster-select', ids: ids });
          });
          kakao.maps.event.addListener(map, 'idle', function () {
            var element = document.getElementById('map');
            if (element.clientWidth !== mapWidth || element.clientHeight !== mapHeight) { relayout(); return; }
            // ResizeObserver and SDK idle can arrive in either order during sheet animation.
            // Only an actual map gesture changes the search region; commands already update the app.
            if (!mapInteraction) return;
            mapInteraction = false;
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
  function drainQueries() {
    while (activeQueries < 3 && queryQueue.length) queryQueue.shift()();
  }
  function query(keyword, options, isCurrent) {
    return new Promise(function (resolve) {
      queryQueue.push(function () {
      if (isCurrent && !isCurrent()) { resolve({ failed: true, rows: [], hasNext: false }); return; }
      activeQueries++;
      var settled = false;
      var timer = setTimeout(function () { finish({ failed: true, rows: [], hasNext: false }); }, 10000);
      function finish(result) {
        if (settled) return;
        settled = true; clearTimeout(timer); activeQueries--; resolve(result); drainQueries();
      }
      try {
        places.keywordSearch(keyword, function (rows, status, pagination) {
          finish({ rows: status === kakao.maps.services.Status.OK ? rows : [],
            failed: status !== kakao.maps.services.Status.OK && status !== kakao.maps.services.Status.ZERO_RESULT,
            hasNext: !!(pagination && pagination.hasNextPage) });
        }, options);
      } catch (error) { finish({ failed: true, rows: [], hasNext: false }); }
      });
      drainQueries();
    });
  }
  function search(command) {
    var brands = Array.from(new Set(command.brands.filter(function (b) { return typeof b === 'string' && b.length > 0 && b.length <= 100; })));
    if (command.reuseCurrent === true && activeSearch && !activeSearch.running && activeSearch.radius === command.radius
      && activeSearch.point.latitude === command.point.latitude && activeSearch.point.longitude === command.point.longitude
      && new Set(activeSearch.brands.concat(brands)).size <= 200) {
      var tasks = [];
      brands.forEach(function (brand) {
        var failed = activeSearch.failed.find(function (task) { return task.brand === brand; });
        if (failed) tasks.push(failed);
        else if (!activeSearch.brands.includes(brand)) tasks.push({ brand: brand, page: 1 });
      });
      activeSearch.brands = Array.from(new Set(activeSearch.brands.concat(brands)));
      runBatch(activeSearch, command.requestId, tasks);
      return;
    }
    activeSearch = { point: command.point, radius: command.radius, brands: brands, rows: [], failed: [], truncated: [], running: false, pending: [] };
    runBatch(activeSearch, command.requestId, brands.map(function (brand) { return { brand: brand, page: 1 }; }));
  }
  async function runBatch(search, requestId, tasks) {
    var generation = ++searchGeneration, cursor = 0, completed = 0;
    var taskBrands = tasks.map(function (task) { return task.brand; });
    search.pending = search.pending.filter(function (task) { return !taskBrands.includes(task.brand); });
    search.failed = search.failed.filter(function (task) { return !taskBrands.includes(task.brand); });
    search.running = true;
    function current() { return generation === searchGeneration; }
    async function worker() {
      while (current() && cursor < tasks.length) {
        var task = tasks[cursor++];
        var result = await query(task.brand, { x: search.point.longitude, y: search.point.latitude,
          radius: search.radius, sort: kakao.maps.services.SortBy.DISTANCE, size: 15, page: task.page }, current);
        if (!current()) return;
        if (result.failed) search.failed.push(task);
        result.rows.forEach(function (p) {
          var point = { latitude: Number(p.y), longitude: Number(p.x) };
          if (!validPoint(point)) return;
          search.rows.push({ id: String(p.id), name: String(p.place_name), address: String(p.road_address_name || p.address_name),
            category: String(p.category_name || ''), point: point, brand: task.brand });
        });
        if (result.hasNext) {
          if (task.page < 3) search.pending.push({ brand: task.brand, page: task.page + 1 });
          else if (!search.truncated.includes(task.brand)) search.truncated.push(task.brand);
        }
        // The SDK may stop pagination at 45 even when more places exist.
        if (task.page === 3 && result.rows.length === 15 && !search.truncated.includes(task.brand)) search.truncated.push(task.brand);
        completed++;
        if (result.rows.length) emit({ type: 'partial-results', requestId: requestId, places: search.rows });
        emit({ type: 'progress', requestId: requestId, completed: completed, total: tasks.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, worker));
    if (!current()) return;
    search.running = false;
    emit({ type: 'results', requestId: requestId, places: search.rows, failedBrands: search.failed.map(function (task) { return task.brand; }),
      truncated: search.truncated.length > 0, truncatedBrands: search.truncated, hasMore: search.pending.length > 0,
      moreBrands: search.pending.map(function (task) { return task.brand; }) });
  }
  async function searchArea(command) {
    var generation = ++areaGeneration;
    var options = { size: 15 };
    if (validPoint(command.point)) {
      options.location = new kakao.maps.LatLng(command.point.latitude, command.point.longitude);
      if (command.suggest || command.nearby) options.sort = kakao.maps.services.SortBy.DISTANCE;
      if (command.radius !== undefined) options.radius = command.radius;
    }
    // Brand queries stay in the selected radius. Explicit destinations remain unrestricted.
    var result = await query(command.query, options, function () { return generation === areaGeneration; });
    if (generation !== areaGeneration) return;
    emit({ type: 'areas', requestId: command.requestId, failed: result.failed,
      areas: result.rows.map(function (p) { return { id: String(p.id), name: String(p.place_name),
        address: String(p.road_address_name || p.address_name), category: String(p.category_name || ''), point: { latitude: Number(p.y), longitude: Number(p.x) } }; }) });
  }
  function drawMarkers(command) {
    clusterer.clear();
    overlayIds.clear();
    if (selectedOverlay) { selectedOverlay.setMap(null); selectedOverlay = null; }
    overlays.forEach(function (overlay) { overlay.setMap(null); }); overlays = [];
    command.places.forEach(function (p) {
      if (!validPoint(p.point)) return;
      var button = document.createElement('button');
      button.type = 'button'; button.textContent = p.brand || p.name;
      button.setAttribute('data-brand', p.brand || p.name);
      button.setAttribute('aria-label', p.name + ' 장소 정보 보기');
      button.setAttribute('aria-pressed', String(p.id === command.selectedId));
      button.addEventListener('click', function () {
        kakao.maps.event.preventMap();
        emit({ type: 'select', id: p.id });
      });
      var overlay = new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(p.point.latitude, p.point.longitude),
        content: button, yAnchor: 1, zIndex: p.id === command.selectedId ? 2 : 1 });
      overlayIds.set(overlay, p.id);
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
    if (command.type === 'cancel') { searchGeneration++; areaGeneration++; activeSearch = null; drainQueries(); return; }
    if (command.type === 'center' && validPoint(command.point)) {
      mapInteraction = false;
      stableCenter = new kakao.maps.LatLng(command.point.latitude, command.point.longitude);
      map.setCenter(stableCenter);
    }
    if (command.type === 'markers' && Array.isArray(command.places)) drawMarkers(command);
    if (!Number.isSafeInteger(command.requestId) || command.requestId < 1) return;
    if (command.type === 'more' && activeSearch && !activeSearch.running && activeSearch.pending.length
      && (command.brands === undefined || Array.isArray(command.brands) && command.brands.length <= 200 && command.brands.every(function (b) { return typeof b === 'string'; }))) {
      runBatch(activeSearch, command.requestId, activeSearch.pending.filter(function (task) { return !command.brands || command.brands.includes(task.brand); }));
    }
    if (command.type === 'area' && typeof command.query === 'string' && command.query.length <= 100
      && (command.point === undefined || validPoint(command.point))
      && (command.suggest === undefined || typeof command.suggest === 'boolean')
      && (command.nearby === undefined || typeof command.nearby === 'boolean')
      && (command.radius === undefined || validPoint(command.point) && [1000, 3000, 5000].includes(command.radius))) searchArea(command);
    if (command.type === 'search' && Array.isArray(command.brands) && command.brands.length <= 200
      && (command.reuseCurrent === undefined || typeof command.reuseCurrent === 'boolean')
      && validPoint(command.point) && [1000, 3000, 5000].includes(command.radius)) search(command);
  }
  window.modeuiMap = { receive: receive };
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    receive(event.data);
  });
})();
