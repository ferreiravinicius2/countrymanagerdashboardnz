/* Weather Tracker — Open-Meteo client + dashboard (static) */
(function () {
  "use strict";

  /**
   * CLIM_FULL_YEARS and MAX_FORECAST_DAYS must match scripts/lib/dashboard-ranges.mjs (generator source of truth).
   * Change both places together, then regenerate the historical database via update-historical.bat.
   */
  /** Number of complete calendar years in the climatology archive window (reduces payload vs 30y WMO). */
  var CLIM_FULL_YEARS = 5;
  /**
   * Fallback climatology cache TTL used only when no historical database is present for a country
   * and the dashboard has to compute climatology live.
   */
  var CLIM_CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000;
  /** Bump when the fallback localStorage shape changes. */
  var CLIM_STORAGE_KEY_PREFIX = "weather-tracker-clim-v4";
  var RAIN_MM = 1.0;
  var MAX_FORECAST_DAYS = 16;
  var HISTORICAL_MANIFEST_PATH = "data/historical/manifest.json";
  var LIVE_CACHE_TTL_MS = 10 * 60 * 1000;
  var ARCHIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  var FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
  var ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

  var locationsData = null;
  /** One row per state; coordinates from first city but all cities used for multi-city aggregation. */
  var flatStates = [];
  var climCache = Object.create(null);
  var climInflight = Object.create(null);
  var requestCache = Object.create(null);
  var requestInflight = Object.create(null);
  var mergedSeriesCache = Object.create(null);
  var mergedSeriesInflight = Object.create(null);
  var historicalManifestPromise = null;
  var historicalCountryCache = Object.create(null);
  /** Snapshot of the historical database state used by the stale-data banner and update modal. */
  var historicalDbStatus = { manifest: null, countries: {}, embedded: false };
  /** Parallel Open-Meteo calls; multi-city aggregation per state still keeps total manageable. */
  var OPEN_METEO_MAX_CONCURRENT = 6;
  var openMeteoQueue = [];
  var openMeteoInflight = 0;
  var charts = { temp: null, dual: null };

  /** Chart line colors aligned with the Modern Minimalist theme. */
  var CHART_LINE_ACTUAL = "#36454f";
  var CHART_LINE_LY = "#708090";
  var CHART_LINE_CLIM = "#b3bcc4";
  var CHART_LINE_BASELINE = "#9aa5ad";
  var CHART_LINE_PRECIP = "#55636d";

  var openFilterDropdownId = null;
  var refreshNonce = 0;
  var latestSelectionData = null;

  function enqueueOpenMeteoFetch(run) {
    return new Promise(function (resolve, reject) {
      openMeteoQueue.push({ run: run, resolve: resolve, reject: reject });
      pumpOpenMeteoQueue();
    });
  }

  function pumpOpenMeteoQueue() {
    while (openMeteoInflight < OPEN_METEO_MAX_CONCURRENT && openMeteoQueue.length) {
      var job = openMeteoQueue.shift();
      openMeteoInflight++;
      job
        .run()
        .then(function (v) {
          openMeteoInflight--;
          job.resolve(v);
          pumpOpenMeteoQueue();
        })
        .catch(function (e) {
          openMeteoInflight--;
          job.reject(e);
          pumpOpenMeteoQueue();
        });
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** Safe text when interpolating into innerHTML (API / Error messages). */
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toISODateLocal(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseISODate(s) {
    var p = s.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function daysBetween(a, b) {
    return Math.round((b - a) / 864e5);
  }

  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  function emptyPeriodStats() {
    return { meanTemp: null, mmDay: null, rainDays: null };
  }

  function uniqueValues(arr) {
    return Array.from(new Set(arr));
  }

  function yieldToBrowser() {
    return new Promise(function (resolve) {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(function () {
          resolve();
        });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  function getCacheData(cache, key, ttlMs) {
    var entry = cache[key];
    if (!entry) return null;
    if (Date.now() - entry.savedAt > ttlMs) {
      delete cache[key];
      return null;
    }
    return entry.data;
  }

  function setCacheData(cache, key, data) {
    cache[key] = { savedAt: Date.now(), data: data };
    return data;
  }

  function supportsLocalJsonFetch() {
    return typeof window !== "undefined" && window.location && window.location.protocol !== "file:";
  }

  function getEmbeddedHistoricalStore() {
    if (typeof window === "undefined") return null;
    return typeof window.__WEATHER_HISTORICAL__ !== "undefined" ? window.__WEATHER_HISTORICAL__ : null;
  }

  function buildSeriesIndex(series) {
    var index = Object.create(null);
    if (!series || !series.time) return index;
    for (var i = 0; i < series.time.length; i++) {
      index[series.time[i]] = i;
    }
    return index;
  }

  /** Last N complete calendar years (excludes current year — incomplete). */
  function getClimatologyYearWindow() {
    var lastComplete = new Date().getFullYear() - 1;
    var startYear = lastComplete - (CLIM_FULL_YEARS - 1);
    return { startYear: startYear, endYear: lastComplete };
  }

  function getClimatologyDateStrings() {
    var w = getClimatologyYearWindow();
    return {
      startStr: w.startYear + "-01-01",
      endStr: w.endYear + "-12-31",
      startYear: w.startYear,
      endYear: w.endYear,
    };
  }

  function readPersistedClimatology(locationId, win) {
    try {
      var key = CLIM_STORAGE_KEY_PREFIX + ":" + locationId;
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (o.v !== 4) return null;
      if (o.startYear !== win.startYear || o.endYear !== win.endYear) return null;
      if (Date.now() - o.savedAt > CLIM_CACHE_TTL_MS) return null;
      if (!o.stats || o.stats.climStartYear == null) return null;
      return o.stats;
    } catch (e) {
      return null;
    }
  }

  function writePersistedClimatology(locationId, stats, win) {
    try {
      var key = CLIM_STORAGE_KEY_PREFIX + ":" + locationId;
      var o = {
        v: 4,
        savedAt: Date.now(),
        startYear: win.startYear,
        endYear: win.endYear,
        stats: stats,
      };
      localStorage.setItem(key, JSON.stringify(o));
    } catch (e) {
      /* Quota, private mode, or disabled storage — session still works from memory. */
    }
  }

  function shiftYears(dateStr, deltaYears) {
    var p = dateStr.split("-").map(Number);
    var y = p[0] + deltaYears;
    var m = p[1];
    var day = p[2];
    var dim = new Date(y, m, 0).getDate();
    if (day > dim) day = dim;
    if (m === 2 && day === 29) {
      var dimFeb = new Date(y, 2, 0).getDate();
      if (day > dimFeb) day = dimFeb;
    }
    return y + "-" + pad2(m) + "-" + pad2(day);
  }

  /**
   * Period windows — must stay aligned with scripts/lib/dashboard-ranges.mjs (getPeriodWindows).
   *
   * Definitions (single source of truth across scorecards and chart KPI text):
   *   - "Current day" is the last day with actual climate data (yesterday in calendar terms,
   *     because today has not closed yet — aligned with the "Last actual" header label).
   *   - MTD  = month 1st → current day
   *   - MTG  = tomorrow of current day (== today in calendar terms) → end of month
   *   - YTD  = January 1st → current day
   *   - Full Month Forecast = month 1st → end of month
   */
  function getPeriodWindows(now) {
    var y = now.getFullYear();
    var m = now.getMonth();
    var lastDay = new Date(y, m + 1, 0).getDate();

    var today = todayStart();
    var currentDay = addDays(today, -1);
    var mtgStart = today;

    var monthStart = new Date(y, m, 1);
    monthStart.setHours(0, 0, 0, 0);
    var fullMonthEnd = new Date(y, m, lastDay);
    fullMonthEnd.setHours(0, 0, 0, 0);

    // MTD: clamp to the current month when "current day" fell on the previous month
    // (e.g. dashboard opened on the 1st → currentDay is the last day of previous month).
    var mtdEnd = currentDay;
    if (mtdEnd < monthStart) mtdEnd = monthStart;
    if (mtdEnd > fullMonthEnd) mtdEnd = fullMonthEnd;

    // MTG: clamp so start never exceeds month end; when MTD already reached the last day,
    // MTG collapses to a single-day placeholder at fullMonthEnd (no forecast left).
    var mtgEnd = fullMonthEnd;
    if (mtgStart > fullMonthEnd) mtgStart = fullMonthEnd;

    var ytdStart = new Date(y, 0, 1);
    ytdStart.setHours(0, 0, 0, 0);
    var ytdEnd = currentDay < ytdStart ? ytdStart : currentDay;

    return {
      mtd: { id: "mtd", title: "Month-to-date (MTD)", start: monthStart, end: mtdEnd },
      forecastMonth: {
        id: "forecastMonth",
        title: "Month-to-go (MTG)",
        start: mtgStart,
        end: mtgEnd,
      },
      ytd: { id: "ytd", title: "YTD", start: ytdStart, end: ytdEnd },
      fullMonthForecast: {
        id: "fullMonthForecast",
        title: "Full Month Forecast",
        start: monthStart,
        end: fullMonthEnd,
      },
    };
  }

  function flattenStates(data) {
    var list = [];
    data.countries.forEach(function (co) {
      co.regions.forEach(function (reg) {
        reg.states.forEach(function (st) {
          if (!st.cities || !st.cities.length) return;
          var rep = st.cities[0];
          list.push({
            id: st.id,
            name: st.name,
            latitude: rep.latitude,
            longitude: rep.longitude,
            stateId: st.id,
            stateName: st.name,
            regionId: reg.id,
            regionName: reg.name,
            countryId: co.id,
            countryName: co.name,
          });
        });
      });
    });
    return list;
  }

  function getCitiesForState(stateId) {
    if (!locationsData) return [];
    var result = [];
    locationsData.countries.forEach(function (co) {
      co.regions.forEach(function (reg) {
        reg.states.forEach(function (st) {
          if (st.id !== stateId) return;
          (st.cities || []).forEach(function (city) {
            result.push({
              id: city.id,
              name: city.name,
              latitude: city.latitude,
              longitude: city.longitude,
              stateId: st.id,
              stateName: st.name,
              regionId: reg.id,
              regionName: reg.name,
              countryId: co.id,
              countryName: co.name,
            });
          });
        });
      });
    });
    return result;
  }

  function getCityPointCount(stateId) {
    if (!locationsData) return 1;
    var n = 0;
    locationsData.countries.forEach(function (co) {
      co.regions.forEach(function (reg) {
        reg.states.forEach(function (st) {
          if (st.id === stateId) n = (st.cities || []).length;
        });
      });
    });
    return n || 1;
  }

  function getTotalCityPoints(stateRows) {
    var sum = 0;
    stateRows.forEach(function (s) { sum += getCityPointCount(s.stateId || s.id); });
    return sum;
  }

  function averageDailySeriesLive(seriesList) {
    var byDate = Object.create(null);
    seriesList.forEach(function (s) {
      if (!s || !s.time) return;
      for (var i = 0; i < s.time.length; i++) {
        var d = s.time[i];
        if (!byDate[d]) byDate[d] = { tmaxS: 0, tmaxN: 0, tminS: 0, tminN: 0, pS: 0, pN: 0 };
        var o = byDate[d];
        if (s.tmax[i] != null) { o.tmaxS += s.tmax[i]; o.tmaxN += 1; }
        if (s.tmin[i] != null) { o.tminS += s.tmin[i]; o.tminN += 1; }
        if (s.precip[i] != null) { o.pS += s.precip[i]; o.pN += 1; }
      }
    });
    var dates = Object.keys(byDate).sort();
    var tmax = [];
    var tmin = [];
    var precip = [];
    dates.forEach(function (d) {
      var o = byDate[d];
      tmax.push(o.tmaxN ? o.tmaxS / o.tmaxN : null);
      tmin.push(o.tminN ? o.tminS / o.tminN : null);
      precip.push(o.pN ? o.pS / o.pN : null);
    });
    return { time: dates, tmax: tmax, tmin: tmin, precip: precip };
  }

  function averageClimLive(climList) {
    var valid = climList.filter(function (c) { return c != null; });
    if (!valid.length) return null;
    if (valid.length === 1) return valid[0];
    var allKeys = Object.create(null);
    valid.forEach(function (c) {
      Object.keys(c.climTemp || {}).forEach(function (k) { allKeys[k] = true; });
      Object.keys(c.climPrecip || {}).forEach(function (k) { allKeys[k] = true; });
      Object.keys(c.climRainFreq || {}).forEach(function (k) { allKeys[k] = true; });
    });
    var climTemp = Object.create(null);
    var climPrecip = Object.create(null);
    var climRainFreq = Object.create(null);
    Object.keys(allKeys).forEach(function (md) {
      var ts = 0, tn = 0, ps = 0, pn = 0, fs = 0, fn = 0;
      valid.forEach(function (c) {
        if (c.climTemp && c.climTemp[md] != null) { ts += c.climTemp[md]; tn += 1; }
        if (c.climPrecip && c.climPrecip[md] != null) { ps += c.climPrecip[md]; pn += 1; }
        if (c.climRainFreq && c.climRainFreq[md] != null) { fs += c.climRainFreq[md]; fn += 1; }
      });
      climTemp[md] = tn ? ts / tn : null;
      climPrecip[md] = pn ? ps / pn : null;
      climRainFreq[md] = fn ? fs / fn : null;
    });
    return {
      climTemp: climTemp,
      climPrecip: climPrecip,
      climRainFreq: climRainFreq,
      climStartYear: valid[0].climStartYear,
      climEndYear: valid[0].climEndYear,
    };
  }

  async function loadLocations() {
    if (typeof window.__WEATHER_LOCATIONS__ !== "undefined" && window.__WEATHER_LOCATIONS__) {
      locationsData = window.__WEATHER_LOCATIONS__;
      flatStates = flattenStates(locationsData);
      return;
    }
    var res = await fetch("data/locations.json");
    if (!res.ok) throw new Error("Failed to load locations");
    locationsData = await res.json();
    flatStates = flattenStates(locationsData);
  }

  async function loadHistoricalManifest() {
    var embedded = getEmbeddedHistoricalStore();
    if (embedded && embedded.manifest) return embedded.manifest;
    if (!supportsLocalJsonFetch()) return null;
    if (!historicalManifestPromise) {
      historicalManifestPromise = fetch(HISTORICAL_MANIFEST_PATH)
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .catch(function () {
          return null;
        });
    }
    return historicalManifestPromise;
  }

  async function loadHistoricalCountry(countryId) {
    var embedded = getEmbeddedHistoricalStore();
    if (embedded && embedded.countries && embedded.countries[countryId]) {
      return embedded.countries[countryId];
    }

    if (historicalCountryCache[countryId]) return historicalCountryCache[countryId];
    if (!supportsLocalJsonFetch()) return null;

    historicalCountryCache[countryId] = (async function () {
      var manifest = await loadHistoricalManifest();
      if (!manifest || !manifest.countries) return null;
      var meta = manifest.countries.find(function (entry) {
        return entry.id === countryId;
      });
      if (!meta || !meta.bundleFile) return null;
      try {
        var res = await fetch("data/historical/" + meta.bundleFile);
        if (!res.ok) return null;
        return res.json();
      } catch (e) {
        return null;
      }
    })();

    return historicalCountryCache[countryId];
  }

  /**
   * Check that a historical bundle uses the same climatology window the dashboard expects.
   * LY year must be exactly current_year - 1 (otherwise the bundle is stale and the banner will prompt an update).
   */
  function isHistoricalBundleCurrent(bundle) {
    if (!bundle) return false;
    if (bundle.climateFullYears !== CLIM_FULL_YEARS) return false;
    var win = getClimatologyYearWindow();
    if (
      !bundle.climatologyRange ||
      bundle.climatologyRange.startYear !== win.startYear ||
      bundle.climatologyRange.endYear !== win.endYear
    ) {
      return false;
    }
    var expectedLy = new Date().getFullYear() - 1;
    return bundle.lyYear === expectedLy;
  }

  /**
   * A bundle may be "stale" (year rolled over) but still usable for the current session.
   * We accept it if the climatology window matches and at least the stored LY year is sensible.
   */
  function isHistoricalBundleUsable(bundle) {
    if (!bundle) return false;
    if (bundle.climateFullYears !== CLIM_FULL_YEARS) return false;
    if (!bundle.climatologyRange || !bundle.states) return false;
    if (typeof bundle.lyYear !== "number") return false;
    return true;
  }

  /**
   * Evaluate the historical database against what the dashboard expects.
   * Drives the stale-data reminder banner and the "Update Historical Data" modal.
   *
   * Returns { status, missing[], stale[], fresh[] } where each entry is { id, label, ... }.
   *   status: "missing" | "stale" | "ok"
   *     - "missing": no manifest / no countries loaded at all (offer update)
   *     - "stale":   at least one country's LY year or climatology window is outdated
   *     - "ok":      every loaded country bundle matches the expected windows
   */
  async function getHistoricalDbStatus() {
    var embedded = getEmbeddedHistoricalStore();
    var manifest = null;
    if (embedded && embedded.manifest) {
      manifest = embedded.manifest;
    } else {
      try {
        manifest = await loadHistoricalManifest();
      } catch (_e) {
        manifest = null;
      }
    }

    var expectedLy = new Date().getFullYear() - 1;
    var climWin = getClimatologyYearWindow();

    if (!manifest || !manifest.countries || !manifest.countries.length) {
      historicalDbStatus = {
        manifest: manifest,
        embedded: !!embedded,
        expectedLyYear: expectedLy,
        expectedClim: climWin,
        missing: (locationsData && locationsData.countries ? locationsData.countries : []).map(function (c) {
          return { id: c.id, label: c.name };
        }),
        stale: [],
        fresh: [],
        status: "missing",
      };
      return historicalDbStatus;
    }

    var byCountryId = Object.create(null);
    manifest.countries.forEach(function (entry) {
      byCountryId[entry.id] = entry;
    });

    var missing = [];
    var stale = [];
    var fresh = [];
    var countries = locationsData && locationsData.countries ? locationsData.countries : [];
    countries.forEach(function (country) {
      var entry = byCountryId[country.id];
      if (!entry) {
        missing.push({ id: country.id, label: country.name });
        return;
      }
      var climOk =
        entry.climatologyRange &&
        entry.climatologyRange.startYear === climWin.startYear &&
        entry.climatologyRange.endYear === climWin.endYear;
      var lyOk = entry.lyYear === expectedLy;
      if (climOk && lyOk) {
        fresh.push({ id: country.id, label: country.name, generatedAt: entry.generatedAt, lyYear: entry.lyYear });
      } else {
        stale.push({
          id: country.id,
          label: country.name,
          generatedAt: entry.generatedAt,
          lyYear: entry.lyYear,
          climatologyRange: entry.climatologyRange,
          reason: !lyOk ? "LY year is " + entry.lyYear + " (expected " + expectedLy + ")" : "climatology window shifted",
        });
      }
    });

    var status = "ok";
    if (!fresh.length && !stale.length) status = "missing";
    else if (stale.length || missing.length) status = "stale";

    historicalDbStatus = {
      manifest: manifest,
      embedded: !!embedded,
      expectedLyYear: expectedLy,
      expectedClim: climWin,
      missing: missing,
      stale: stale,
      fresh: fresh,
      status: status,
    };
    return historicalDbStatus;
  }

  function getCountryById(id) {
    return locationsData.countries.find(function (c) {
      return c.id === id;
    });
  }

  function populateCountrySelect() {
    var sel = $("filter-country");
    sel.innerHTML = "";
    locationsData.countries.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      sel.appendChild(o);
    });
  }

  function closeAllFilterDropdowns() {
    [
      "filter-region-root",
      "filter-state-root",
      "export-region-root",
      "export-state-root",
    ].forEach(function (rid) {
      var root = $(rid);
      if (!root) return;
      var panel = root.querySelector(".filter-dropdown__panel");
      var trig = root.querySelector(".filter-dropdown__trigger");
      if (panel) panel.hidden = true;
      if (trig) trig.setAttribute("aria-expanded", "false");
    });
    openFilterDropdownId = null;
  }

  function toggleFilterDropdown(rootId) {
    var root = $(rootId);
    if (!root) return;
    var panel = root.querySelector(".filter-dropdown__panel");
    var trig = root.querySelector(".filter-dropdown__trigger");
    if (!panel || !trig) return;
    var isOpen = openFilterDropdownId === rootId && !panel.hidden;
    closeAllFilterDropdowns();
    if (!isOpen) {
      panel.hidden = false;
      trig.setAttribute("aria-expanded", "true");
      openFilterDropdownId = rootId;
    }
  }

  function getCheckedIdsFromList(listEl) {
    if (!listEl) return [];
    var out = [];
    listEl.querySelectorAll('input[type="checkbox"]').forEach(function (inp) {
      if (inp.checked) out.push(inp.value);
    });
    return out;
  }

  function getSelectedRegionIds() {
    return getCheckedIdsFromList($("filter-region-list"));
  }

  function getSelectedStateIds() {
    return getCheckedIdsFromList($("filter-state-list"));
  }

  function updateRegionTriggerLabel() {
    var list = $("filter-region-list");
    var trig = $("filter-region-trigger");
    if (!list || !trig) return;
    var boxes = list.querySelectorAll('input[type="checkbox"]');
    var n = boxes.length;
    var c = 0;
    boxes.forEach(function (b) {
      if (b.checked) c += 1;
    });
    if (!n) {
      trig.textContent = "—";
      return;
    }
    if (c === 0) {
      trig.textContent = "All regions (scope)";
      return;
    }
    if (c === n) {
      trig.textContent = "All regions (" + n + ")";
      return;
    }
    trig.textContent = c + " region" + (c === 1 ? "" : "s");
  }

  function updateStateTriggerLabel() {
    var list = $("filter-state-list");
    var trig = $("filter-state-trigger");
    if (!list || !trig) return;
    var boxes = list.querySelectorAll('input[type="checkbox"]');
    var n = boxes.length;
    var c = 0;
    boxes.forEach(function (b) {
      if (b.checked) c += 1;
    });
    if (!n) {
      trig.textContent = "—";
      return;
    }
    if (c === 0) {
      trig.textContent = "No states";
      return;
    }
    if (c === n) {
      trig.textContent = "All states (" + n + ")";
      return;
    }
    trig.textContent = c + " state" + (c === 1 ? "" : "s");
  }

  function syncFiltersFromCountry() {
    var cid = $("filter-country").value;
    var country = getCountryById(cid);
    var regList = $("filter-region-list");
    var stList = $("filter-state-list");
    if (regList) regList.innerHTML = "";
    if (stList) stList.innerHTML = "";
    if (!country) {
      updateRegionTriggerLabel();
      updateStateTriggerLabel();
      return;
    }
    country.regions.forEach(function (r) {
      var lab = document.createElement("label");
      lab.className = "filter-dropdown__item";
      var inp = document.createElement("input");
      inp.type = "checkbox";
      inp.name = "filter-region";
      inp.value = r.id;
      inp.checked = true;
      var span = document.createElement("span");
      span.textContent = r.name;
      lab.appendChild(inp);
      lab.appendChild(span);
      regList.appendChild(lab);
    });
    updateRegionTriggerLabel();
    refillStateOptions(true);
  }

  function listStatesForRegions(countryId, regionIds) {
    var country = getCountryById(countryId);
    var set = {};
    country.regions.forEach(function (r) {
      if (regionIds.length && regionIds.indexOf(r.id) === -1) return;
      r.states.forEach(function (s) {
        set[s.id] = s;
      });
    });
    return Object.keys(set).map(function (k) {
      return set[k];
    });
  }

  function listStatesForFilters(countryId, regionIds) {
    return flatStates.filter(function (s) {
      if (s.countryId !== countryId) return false;
      if (regionIds.length && regionIds.indexOf(s.regionId) === -1) return false;
      return true;
    });
  }

  function getSelectedLocationObjects() {
    var countryId = $("filter-country").value;
    var regionIds = getSelectedRegionIds();
    var stateIds = getSelectedStateIds();
    if (!countryId || !stateIds.length) return [];
    var pool = listStatesForFilters(countryId, regionIds);
    return pool.filter(function (s) {
      return stateIds.indexOf(s.id) !== -1;
    });
  }

  function refillStateOptions(selectAllWhenEmpty) {
    var countryId = $("filter-country").value;
    var regionIds = getSelectedRegionIds();
    var stList = $("filter-state-list");
    if (!stList) return;
    var prevStates = [];
    stList.querySelectorAll('input[name="filter-state"]').forEach(function (inp) {
      if (inp.checked) prevStates.push(inp.value);
    });
    var states = listStatesForRegions(countryId, regionIds);
    stList.innerHTML = "";
    states.forEach(function (s) {
      var lab = document.createElement("label");
      lab.className = "filter-dropdown__item";
      var inp = document.createElement("input");
      inp.type = "checkbox";
      inp.name = "filter-state";
      inp.value = s.id;
      inp.checked = (selectAllWhenEmpty && !prevStates.length) || prevStates.indexOf(s.id) !== -1;
      var span = document.createElement("span");
      span.textContent = s.name;
      lab.appendChild(inp);
      lab.appendChild(span);
      stList.appendChild(lab);
    });
    var nChecked = 0;
    stList.querySelectorAll('input[name="filter-state"]').forEach(function (inp) {
      if (inp.checked) nChecked += 1;
    });
    if (nChecked === 0) {
      setAllStateCheckboxes(true);
    }
    updateStateTriggerLabel();
  }

  function setAllRegionCheckboxes(checked) {
    var list = $("filter-region-list");
    if (!list) return;
    list.querySelectorAll('input[type="checkbox"]').forEach(function (inp) {
      inp.checked = checked;
    });
    updateRegionTriggerLabel();
  }

  function setAllStateCheckboxes(checked) {
    var list = $("filter-state-list");
    if (!list) return;
    list.querySelectorAll('input[type="checkbox"]').forEach(function (inp) {
      inp.checked = checked;
    });
    updateStateTriggerLabel();
  }

  function getRequestTtlMs(url) {
    return url.indexOf(ARCHIVE_URL) === 0 ? ARCHIVE_CACHE_TTL_MS : LIVE_CACHE_TTL_MS;
  }

  async function fetchJson(url) {
    var ttlMs = getRequestTtlMs(url);
    var cached = getCacheData(requestCache, url, ttlMs);
    if (cached) return cached;
    if (requestInflight[url]) return requestInflight[url];

    requestInflight[url] = enqueueOpenMeteoFetch(function () {
      return fetchJsonImpl(url);
    })
      .then(function (data) {
        delete requestInflight[url];
        return setCacheData(requestCache, url, data);
      })
      .catch(function (err) {
        delete requestInflight[url];
        throw err;
      });
    return requestInflight[url];
  }

  async function fetchJsonImpl(url) {
    var maxAttempts = 10;
    var attempt = 0;
    while (true) {
      var res = await fetch(url);
      if (res.status === 429 && attempt < maxAttempts) {
        var ra = res.headers.get("Retry-After");
        var waitMs = 800 * Math.pow(2, attempt);
        if (ra && /^\d+$/.test(String(ra).trim())) {
          waitMs = Math.min(120000, parseInt(ra, 10) * 1000);
        }
        waitMs = Math.min(90000, waitMs);
        await new Promise(function (r) {
          setTimeout(r, waitMs);
        });
        attempt++;
        continue;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }
  }

  function buildQuery(params) {
    var esc = encodeURIComponent;
    return Object.keys(params)
      .map(function (k) {
        return esc(k) + "=" + esc(String(params[k]));
      })
      .join("&");
  }

  function dailyMeanTemp(tmaxArr, tminArr, i) {
    if (tmaxArr == null || tminArr == null) return null;
    return (tmaxArr[i] + tminArr[i]) / 2;
  }

  function alignMeanSeries(cities, getter) {
    var map = Object.create(null);
    cities.forEach(function (c) {
      var s = getter(c);
      if (!s || !s.time) return;
      for (var i = 0; i < s.time.length; i++) {
        var d = s.time[i];
        if (!map[d]) map[d] = { n: 0, t: 0, p: 0 };
        var t = dailyMeanTemp(s.tmax, s.tmin, i);
        var p = s.precip[i] != null ? s.precip[i] : 0;
        if (t != null) {
          map[d].t += t;
          map[d].p += p;
          map[d].n += 1;
        }
      }
    });
    var dates = Object.keys(map).sort();
    var tmean = [];
    var pmean = [];
    dates.forEach(function (d) {
      var o = map[d];
      tmean.push(o.n ? o.t / o.n : null);
      pmean.push(o.n ? o.p / o.n : null);
    });
    return { time: dates, tmean: tmean, precip: pmean };
  }

  function sliceSeriesByDate(series, startStr, endStr) {
    if (!series || !series.time) return null;
    var times = [];
    var tmax = [];
    var tmin = [];
    var precip = [];
    for (var i = 0; i < series.time.length; i++) {
      var d = series.time[i];
      if (d >= startStr && d <= endStr) {
        times.push(d);
        tmax.push(series.tmax[i]);
        tmin.push(series.tmin[i]);
        precip.push(series.precip[i]);
      }
    }
    return { time: times, tmax: tmax, tmin: tmin, precip: precip };
  }

  function computePeriodStats(s) {
    if (!s || !s.time || !s.time.length) {
      return {
        meanTemp: null,
        mmDay: null,
        rainDays: null,
      };
    }
    var mt = 0;
    var pc = 0;
    var rd = 0;
    var n = 0;
    for (var i = 0; i < s.time.length; i++) {
      var tm = dailyMeanTemp(s.tmax, s.tmin, i);
      var pr = s.precip[i] != null ? s.precip[i] : 0;
      if (tm == null) continue;
      mt += tm;
      pc += pr;
      if (pr >= RAIN_MM) rd += 1;
      n += 1;
    }
    if (!n) return { meanTemp: null, mmDay: null, rainDays: null };
    return {
      meanTemp: mt / n,
      mmDay: pc / n,
      rainDays: rd,
    };
  }

  function deltaParts(val, base) {
    if (val == null || base == null || !isFinite(val) || !isFinite(base)) {
      return { d: null, p: null };
    }
    var d = val - base;
    var p = base !== 0 ? (d / base) * 100 : d === 0 ? 0 : null;
    return { d: d, p: p };
  }

  function fmtDelta(d, p) {
    if (d == null) return "—";
    var a = (d >= 0 ? "+" : "") + d.toFixed(1);
    if (p == null || !isFinite(p)) return a + " ( —% )";
    var ps = (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
    return a + " (" + ps + ")";
  }

  function cellClass(d) {
    if (d == null || !isFinite(d)) return "";
    return d >= 0 ? "delta-pos" : "delta-neg";
  }

  /** More rain / rain days = worse for sales → invert sign vs temperature. */
  function cellClassRain(d) {
    if (d == null || !isFinite(d)) return "";
    return d >= 0 ? "delta-neg" : "delta-pos";
  }

  function getComparisonBaselineMode() {
    var pb = $("period-baseline");
    var cb = $("chart-baseline");
    if (pb && pb.value) return pb.value;
    if (cb && cb.value) return cb.value;
    return "ly";
  }

  function syncBaselineSelects(sourceValue) {
    var pb = $("period-baseline");
    var cb = $("chart-baseline");
    if (pb) pb.value = sourceValue;
    if (cb) cb.value = sourceValue;
  }

  async function fetchArchiveDaily(lat, lon, startStr, endStr) {
    var q = buildQuery({
      latitude: lat,
      longitude: lon,
      start_date: startStr,
      end_date: endStr,
      daily: [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
      ].join(","),
      timezone: "auto",
    });
    var data = await fetchJson(ARCHIVE_URL + "?" + q);
    return {
      time: data.daily.time,
      tmax: data.daily.temperature_2m_max,
      tmin: data.daily.temperature_2m_min,
      precip: data.daily.precipitation_sum,
    };
  }

  async function fetchForecastWindow(lat, lon, pastDays, forecastDays) {
    var q = buildQuery({
      latitude: lat,
      longitude: lon,
      daily: [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
      ].join(","),
      past_days: pastDays,
      forecast_days: forecastDays,
      timezone: "auto",
    });
    var data = await fetchJson(FORECAST_URL + "?" + q);
    return {
      time: data.daily.time,
      tmax: data.daily.temperature_2m_max,
      tmin: data.daily.temperature_2m_min,
      precip: data.daily.precipitation_sum,
    };
  }

  function todayStart() {
    var n = new Date();
    n.setHours(0, 0, 0, 0);
    return n;
  }

  function getMergedSeriesTtlMs(rangeEndStr) {
    return rangeEndStr >= toISODateLocal(todayStart()) ? LIVE_CACHE_TTL_MS : ARCHIVE_CACHE_TTL_MS;
  }

  async function fetchMergedDailyForCity(c, rangeStartStr, rangeEndStr) {
    var cacheKey = c.id + "|" + rangeStartStr + "|" + rangeEndStr;
    var ttlMs = getMergedSeriesTtlMs(rangeEndStr);
    var cached = getCacheData(mergedSeriesCache, cacheKey, ttlMs);
    if (cached) return cached;
    if (mergedSeriesInflight[cacheKey]) return mergedSeriesInflight[cacheKey];

    mergedSeriesInflight[cacheKey] = (async function () {
      var today = todayStart();
      var s = parseISODate(rangeStartStr);
      var e = parseISODate(rangeEndStr);
      var todayStr = toISODateLocal(today);
      if (rangeEndStr < todayStr) {
        return fetchArchiveDaily(c.latitude, c.longitude, rangeStartStr, rangeEndStr);
      }
      if (rangeStartStr > todayStr) {
        var ndFutureOnly = daysBetween(s, e) + 1;
        var fdFutureOnly = Math.min(MAX_FORECAST_DAYS, ndFutureOnly);
        var futureOnly = await fetchForecastWindow(c.latitude, c.longitude, 0, fdFutureOnly);
        return sliceSeriesByDate(futureOnly, rangeStartStr, rangeEndStr);
      }

      var partPastEnd = addDays(today, -1);
      var partPastEndStr = toISODateLocal(partPastEnd);
      var seriesPast =
        rangeStartStr <= partPastEndStr
          ? await fetchArchiveDaily(c.latitude, c.longitude, rangeStartStr, partPastEndStr)
          : { time: [], tmax: [], tmin: [], precip: [] };
      var ndFut = daysBetween(today, e) + 1;
      var fd = Math.min(MAX_FORECAST_DAYS, Math.max(ndFut, 0));
      var seriesFut =
        rangeEndStr >= todayStr
          ? await fetchForecastWindow(c.latitude, c.longitude, 0, fd)
          : { time: [], tmax: [], tmin: [], precip: [] };
      var futSlice = sliceSeriesByDate(seriesFut, todayStr, rangeEndStr);
      return concatSeries(seriesPast, futSlice);
    })()
      .then(function (series) {
        delete mergedSeriesInflight[cacheKey];
        return setCacheData(mergedSeriesCache, cacheKey, series);
      })
      .catch(function (err) {
        delete mergedSeriesInflight[cacheKey];
        throw err;
      });

    return mergedSeriesInflight[cacheKey];
  }

  function concatSeries(a, b) {
    return {
      time: (a.time || []).concat(b.time || []),
      tmax: (a.tmax || []).concat(b.tmax || []),
      tmin: (a.tmin || []).concat(b.tmin || []),
      precip: (a.precip || []).concat(b.precip || []),
    };
  }

  async function ensureClimatology(c) {
    if (climCache[c.id]) return climCache[c.id];
    if (climInflight[c.id]) return climInflight[c.id];
    var win = getClimatologyDateStrings();
    var persisted = readPersistedClimatology(c.id, win);
    if (persisted) {
      climCache[c.id] = persisted;
      return persisted;
    }
    climInflight[c.id] = (async function () {
      var raw = await fetchArchiveDaily(c.latitude, c.longitude, win.startStr, win.endStr);
      var stats = buildClimatologyStats(raw, win.startYear, win.endYear);
      climCache[c.id] = stats;
      writePersistedClimatology(c.id, stats, win);
      delete climInflight[c.id];
      return stats;
    })().catch(function (err) {
      delete climInflight[c.id];
      throw err;
    });
    return climInflight[c.id];
  }

  function buildClimatologyStats(raw, climStartYear, climEndYear) {
    var byMD = Object.create(null);
    var rainFreqByMD = Object.create(null);
    for (var i = 0; i < raw.time.length; i++) {
      var d = raw.time[i];
      var p = d.split("-");
      var md = p[1] + "-" + p[2];
      var mdTemp = md === "02-29" ? "02-28" : md;
      var tm = dailyMeanTemp(raw.tmax, raw.tmin, i);
      var pr = raw.precip[i] != null ? raw.precip[i] : 0;
      if (!byMD[mdTemp]) byMD[mdTemp] = { t: [], p: [] };
      if (tm != null) {
        byMD[mdTemp].t.push(tm);
        byMD[mdTemp].p.push(pr);
      }
      if (!rainFreqByMD[md]) rainFreqByMD[md] = { rainy: 0, total: 0 };
      rainFreqByMD[md].total += 1;
      if (pr >= RAIN_MM) rainFreqByMD[md].rainy += 1;
    }
    var climTemp = Object.create(null);
    var climPrecip = Object.create(null);
    var climRainFreq = Object.create(null);
    Object.keys(byMD).forEach(function (md) {
      var o = byMD[md];
      climTemp[md] = o.t.length ? o.t.reduce(function (a, b) { return a + b; }, 0) / o.t.length : null;
      climPrecip[md] = o.p.length ? o.p.reduce(function (a, b) { return a + b; }, 0) / o.p.length : null;
    });
    Object.keys(rainFreqByMD).forEach(function (md) {
      var row = rainFreqByMD[md];
      climRainFreq[md] = row.total ? row.rainy / row.total : null;
    });
    return {
      climTemp: climTemp,
      climPrecip: climPrecip,
      climRainFreq: climRainFreq,
      climStartYear: climStartYear,
      climEndYear: climEndYear,
    };
  }

  function climPeriodMeanTemp(clim, startStr, endStr) {
    var s = parseISODate(startStr);
    var e = parseISODate(endStr);
    var acc = 0;
    var n = 0;
    for (var d = new Date(s); d <= e; d = addDays(d, 1)) {
      var md = pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
      var key = md;
      if (key === "02-29") key = "02-28";
      var v = clim.climTemp[key];
      if (v != null) {
        acc += v;
        n += 1;
      }
    }
    return n ? acc / n : null;
  }

  function climPeriodRainDaysExpected(clim, startStr, endStr) {
    if (clim.climRainFreq) {
      var sFreq = parseISODate(startStr);
      var eFreq = parseISODate(endStr);
      var accFreq = 0;
      for (var dd = new Date(sFreq); dd <= eFreq; dd = addDays(dd, 1)) {
        var mdKey = pad2(dd.getMonth() + 1) + "-" + pad2(dd.getDate());
        var freq = clim.climRainFreq[mdKey];
        if (freq == null && mdKey === "02-29") freq = clim.climRainFreq["02-28"];
        if (freq != null) accFreq += freq;
      }
      return accFreq;
    }

    var smd = parseISODate(startStr);
    var emd = parseISODate(endStr);
    var counts = [];
    var y0 = clim.climStartYear;
    var y1 = clim.climEndYear;
    if (y0 == null || y1 == null) return null;
    for (var y = y0; y <= y1; y++) {
      var s = new Date(y, smd.getMonth(), smd.getDate());
      var e = new Date(y, emd.getMonth(), emd.getDate());
      var arr = clim.byYearRain[y];
      if (!arr) {
        counts.push(0);
        continue;
      }
      var rd = 0;
      arr.forEach(function (row) {
        var d = parseISODate(row.d);
        if (d >= s && d <= e && row.pr >= RAIN_MM) rd += 1;
      });
      counts.push(rd);
    }
    return counts.length
      ? counts.reduce(function (a, b) {
          return a + b;
        }, 0) / counts.length
      : null;
  }

  function climPeriodMmDay(clim, startStr, endStr) {
    var s = parseISODate(startStr);
    var e = parseISODate(endStr);
    var acc = 0;
    var n = 0;
    for (var d = new Date(s); d <= e; d = addDays(d, 1)) {
      var key = pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
      var ck = key === "02-29" ? "02-28" : key;
      var v = clim.climPrecip[ck];
      if (v != null) {
        acc += v;
        n += 1;
      }
    }
    return n ? acc / n : null;
  }

  function aggregatePeriodRollup(entries) {
    function avgLayer(layer) {
      function avgField(field) {
        var ok = entries.filter(function (e) {
          var x = e[layer];
          return x && x[field] != null && isFinite(x[field]);
        });
        if (!ok.length) return null;
        return (
          ok.reduce(function (s, e) {
            return s + e[layer][field];
          }, 0) / ok.length
        );
      }
      return {
        meanTemp: avgField("meanTemp"),
        mmDay: avgField("mmDay"),
        rainDays: avgField("rainDays"),
      };
    }
    return {
      current: avgLayer("current"),
      ly: avgLayer("ly"),
      his: avgLayer("his"),
      errors: [],
    };
  }

  /**
   * Union of date ranges for API loads — string ranges must match scripts/lib/dashboard-ranges.mjs
   * (getBundleDashboardRanges) for the historical database generator to stay aligned.
   */
  function getDashboardRanges(now) {
    var today = todayStart();
    var windows = getPeriodWindows(now);
    var chartStart = addDays(today, -28);
    var chartEnd = addDays(today, MAX_FORECAST_DAYS);
    var startTimes = [today.getTime(), chartStart.getTime()];
    var endTimes = [today.getTime(), chartEnd.getTime()];

    Object.keys(windows).forEach(function (key) {
      startTimes.push(windows[key].start.getTime());
      endTimes.push(windows[key].end.getTime());
    });

    var currentStart = new Date(Math.min.apply(null, startTimes));
    var currentEnd = new Date(Math.max.apply(null, endTimes));
    currentStart.setHours(0, 0, 0, 0);
    currentEnd.setHours(0, 0, 0, 0);

    var currentStartStr = toISODateLocal(currentStart);
    var currentEndStr = toISODateLocal(currentEnd);
    return {
      today: today,
      todayStr: toISODateLocal(today),
      windows: windows,
      periodKeys: ["mtd", "forecastMonth", "ytd", "fullMonthForecast"],
      currentRange: {
        start: currentStart,
        end: currentEnd,
        startStr: currentStartStr,
        endStr: currentEndStr,
      },
      lyRange: {
        startStr: shiftYears(currentStartStr, -1),
        endStr: shiftYears(currentEndStr, -1),
      },
      chart: {
        start: chartStart,
        end: chartEnd,
        startStr: toISODateLocal(chartStart),
        endStr: toISODateLocal(chartEnd),
      },
    };
  }

  /**
   * Build a record for one state row. The current-year series always comes from the live API
   * (only layer that changes daily). LY and climatology come from the local historical bundle
   * when available, otherwise we fall back to live archive calls.
   */
  async function buildSelectionRecordForState(stateRow, ranges, stateHistorical) {
    var cities = getCitiesForState(stateRow.stateId || stateRow.id);
    var useCities = cities.length ? cities : [stateRow];

    // Current series: always live (one call per city, merged archive+forecast).
    var currentPromises = useCities.map(function (c) {
      return fetchMergedDailyForCity(c, ranges.currentRange.startStr, ranges.currentRange.endStr).catch(function (err) {
        return { __error: err };
      });
    });

    // LY + climatology: prefer the historical bundle.
    var hasHistorical = !!(stateHistorical && stateHistorical.lySeries && stateHistorical.clim);

    var lyPromise;
    var climPromise;
    if (hasHistorical) {
      lyPromise = Promise.resolve(stateHistorical.lySeries);
      climPromise = Promise.resolve(stateHistorical.clim);
    } else {
      // Fallback path: live archive per city, averaged when multiple cities.
      var lyCityPromises = useCities.map(function (c) {
        return fetchArchiveDaily(c.latitude, c.longitude, ranges.lyRange.startStr, ranges.lyRange.endStr).catch(
          function (err) {
            return { __error: err };
          }
        );
      });
      var climCityPromises = useCities.map(function (c) {
        return ensureClimatology(c).catch(function (err) {
          return { __error: err };
        });
      });
      lyPromise = Promise.all(lyCityPromises).then(function (results) {
        var ok = results.filter(function (r) { return r && !r.__error; });
        if (!ok.length) return null;
        return ok.length === 1 ? ok[0] : averageDailySeriesLive(ok);
      });
      climPromise = Promise.all(climCityPromises).then(function (results) {
        var ok = results.filter(function (r) { return r && !r.__error; });
        if (!ok.length) return null;
        return ok.length === 1 ? ok[0] : averageClimLive(ok);
      });
    }

    try {
      var currentResults = await Promise.all(currentPromises);
      var okCurrent = currentResults.filter(function (r) { return r && !r.__error; });
      var errCurrent = currentResults.filter(function (r) { return r && r.__error; });

      var currentSeries = null;
      if (okCurrent.length) {
        currentSeries = okCurrent.length === 1 ? okCurrent[0] : averageDailySeriesLive(okCurrent);
      }

      var lySeries = await lyPromise;
      var clim = await climPromise;

      var errorMessages = [];
      if (!currentSeries) {
        var msg = errCurrent.length && errCurrent[0].__error && errCurrent[0].__error.message
          ? errCurrent[0].__error.message
          : "current series unavailable";
        errorMessages.push(stateRow.name + ": " + msg);
      }

      return {
        city: stateRow,
        currentSeries: currentSeries,
        lySeries: lySeries,
        lyIndex: buildSeriesIndex(lySeries),
        clim: clim,
        source: hasHistorical ? "historical" : "live",
        error: errorMessages.length ? errorMessages.join("; ") : null,
      };
    } catch (err) {
      return {
        city: stateRow,
        currentSeries: null,
        lySeries: null,
        lyIndex: Object.create(null),
        clim: null,
        source: hasHistorical ? "historical" : "live",
        error: stateRow.name + ": " + err.message,
      };
    }
  }

  async function loadSelectionData(cities, now) {
    var ranges = getDashboardRanges(now);
    var countryId = cities.length ? cities[0].countryId : null;
    var historicalCountry = countryId ? await loadHistoricalCountry(countryId) : null;
    if (!isHistoricalBundleUsable(historicalCountry)) historicalCountry = null;

    var records = await Promise.all(
      cities.map(function (c) {
        var stateHist =
          historicalCountry && historicalCountry.states ? historicalCountry.states[c.id] || null : null;
        return buildSelectionRecordForState(c, ranges, stateHist);
      })
    );

    var byId = Object.create(null);
    var sourceCounts = { historical: 0, live: 0 };
    records.forEach(function (record) {
      byId[record.city.id] = record;
      if (record.source === "historical") sourceCounts.historical += 1;
      else sourceCounts.live += 1;
    });

    return {
      now: now,
      cities: cities.slice(),
      byId: byId,
      groupedByRegion: groupCitiesByRegion(cities),
      ranges: ranges,
      periodDetailCache: Object.create(null),
      alignedSeriesCache: Object.create(null),
      sourceCounts: sourceCounts,
      historicalCountry: historicalCountry,
    };
  }

  function getPeriodDetail(selectionData, startStr, endStr) {
    var key = startStr + "|" + endStr;
    if (selectionData.periodDetailCache[key]) return selectionData.periodDetailCache[key];

    var lyStart = shiftYears(startStr, -1);
    var lyEnd = shiftYears(endStr, -1);
    var errors = [];
    var entries = selectionData.cities.map(function (city) {
      var record = selectionData.byId[city.id];
      if (!record || record.error || !record.currentSeries || !record.lySeries || !record.clim) {
        if (record && record.error) errors.push(record.error);
        return {
          city: city,
          current: emptyPeriodStats(),
          ly: emptyPeriodStats(),
          his: emptyPeriodStats(),
        };
      }

      return {
        city: city,
        current: computePeriodStats(sliceSeriesByDate(record.currentSeries, startStr, endStr)),
        ly: computePeriodStats(sliceSeriesByDate(record.lySeries, lyStart, lyEnd)),
        his: {
          meanTemp: climPeriodMeanTemp(record.clim, startStr, endStr),
          mmDay: climPeriodMmDay(record.clim, startStr, endStr),
          rainDays: climPeriodRainDaysExpected(record.clim, startStr, endStr),
        },
      };
    });

    selectionData.periodDetailCache[key] = {
      entries: entries,
      errors: uniqueValues(errors),
    };
    return selectionData.periodDetailCache[key];
  }

  function getRollupForRange(selectionData, startStr, endStr) {
    var detail = getPeriodDetail(selectionData, startStr, endStr);
    var rollup = aggregatePeriodRollup(detail.entries);
    rollup.errors = detail.errors;
    return rollup;
  }

  function groupCitiesByRegion(cities) {
    var map = Object.create(null);
    cities.forEach(function (c) {
      if (!map[c.regionId]) map[c.regionId] = { name: c.regionName, cities: [] };
      map[c.regionId].cities.push(c);
    });
    return map;
  }

  function buildRowsForPeriod(selectionData, startStr, endStr) {
    var detail = getPeriodDetail(selectionData, startStr, endStr);
    var g = selectionData.groupedByRegion;
    var rkeys = Object.keys(g);
    var regionRows = rkeys.map(function (gid) {
      var grp = g[gid];
      var entriesInRegion = detail.entries.filter(function (e) {
        return e.city.regionId === gid;
      });
      var data = aggregatePeriodRollup(entriesInRegion);
      return { label: grp.name, data: data };
    });
    var total = aggregatePeriodRollup(detail.entries);
    total.errors = detail.errors;
    return regionRows.concat([{ label: "Total", data: total, isTotal: true }]);
  }

  function renderMetricTable(rows, mode) {
    var vsHead = mode === "his" ? "vs Hist" : "vs LY";
    var html = '<div class="table-wrap"><table class="score-table">';
    html += "<thead><tr>";
    html += '<th rowspan="2">Geography</th>';
    html += '<th colspan="2" class="group-header">Temperature</th>';
    html += '<th colspan="4" class="group-header">Pluviometric index</th>';
    html += "</tr><tr>";
    ["Avg °C", vsHead, "mm/day", vsHead, "Rain days", vsHead].forEach(function (h) {
      html += "<th>" + h + "</th>";
    });
    html += "</tr></thead><tbody>";
    var errMsg = "";
    rows.forEach(function (row) {
      var d = row.data;
      var cur = d.current;
      var ly = d.ly;
      var hi = d.his;
      var base = mode === "his" ? hi : ly;
      var cT = deltaParts(cur.meanTemp, base.meanTemp);
      var cM = deltaParts(cur.mmDay, base.mmDay);
      var cR = deltaParts(cur.rainDays, base.rainDays);
      if (row.isTotal && d.errors && d.errors.length) errMsg = d.errors.join("; ");
      var trc = row.isTotal ? " total-row" : "";
      html += "<tr class=\"" + trc + '">';
      html += "<td>" + row.label + "</td>";
      html += "<td>" + (cur.meanTemp != null ? cur.meanTemp.toFixed(1) : "—") + "</td>";
      html += '<td class="' + cellClass(cT.d) + '">' + fmtDelta(cT.d, cT.p) + "</td>";
      html += "<td>" + (cur.mmDay != null ? cur.mmDay.toFixed(2) : "—") + "</td>";
      html += '<td class="' + cellClassRain(cM.d) + '">' + fmtDelta(cM.d, cM.p) + "</td>";
      html += "<td>" + (cur.rainDays != null ? cur.rainDays.toFixed(0) : "—") + "</td>";
      html += '<td class="' + cellClassRain(cR.d) + '">' + fmtDelta(cR.d, cR.p) + "</td>";
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    if (errMsg) html += '<p class="muted tiny">' + errMsg + "</p>";
    return html;
  }

  function renderPeriodCard(key, w, rows) {
    var sub =
      toISODateLocal(w.start) === toISODateLocal(w.end)
        ? toISODateLocal(w.start)
        : toISODateLocal(w.start) + " → " + toISODateLocal(w.end);
    return (
      '<div class="period-card" data-period="' +
      key +
      '">' +
      '<div class="period-card__head">' +
      w.title +
      '<div class="period-card__sub">' +
      sub +
      "</div></div>" +
      renderMetricTable(rows, getComparisonBaselineMode()) +
      "</div>"
    );
  }

  function renderPeriodGridSync(selectionData) {
    var host = $("period-grid");
    if (!host) return;
    host.innerHTML = "";
    for (var i = 0; i < selectionData.ranges.periodKeys.length; i++) {
      var key = selectionData.ranges.periodKeys[i];
      var w = selectionData.ranges.windows[key];
      var rows = buildRowsForPeriod(selectionData, toISODateLocal(w.start), toISODateLocal(w.end));
      host.insertAdjacentHTML("beforeend", renderPeriodCard(key, w, rows));
    }
  }

  function renderSnapshotGrid(rollup) {
    var c = rollup.current;
    var ly = rollup.ly;
    var dTemp = deltaParts(c.meanTemp, ly.meanTemp);
    var dMm = deltaParts(c.mmDay, ly.mmDay);
    var dRd = deltaParts(c.rainDays, ly.rainDays);
    function absFmtVal(d, dec) {
      if (d == null || !isFinite(d)) return "—";
      return (d >= 0 ? "+" : "") + d.toFixed(dec);
    }
    function pctFmtVal(p) {
      if (p == null || !isFinite(p)) return "—";
      return (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
    }
    function block(title, avgStr, dp, decAbs, clsFn) {
      var ccls = clsFn(dp.d);
      return (
        '<div class="snapshot-block">' +
        '<h3 class="snapshot-block__title">' +
        title +
        "</h3>" +
        '<div class="snapshot-block__row">' +
        '<span><span class="snap-label">Average</span> <span class="snap-value">' +
        avgStr +
        "</span></span>" +
        '<span><span class="snap-label">vs LY Δ</span> <span class="snap-value ' +
        ccls +
        '">' +
        absFmtVal(dp.d, decAbs) +
        "</span></span>" +
        '<span><span class="snap-label">vs LY %</span> <span class="snap-value ' +
        ccls +
        '">' +
        pctFmtVal(dp.p) +
        "</span></span>" +
        "</div></div>"
      );
    }
    var avgTemp =
      c.meanTemp != null && isFinite(c.meanTemp) ? c.meanTemp.toFixed(1) + " °C" : "—";
    var avgMm = c.mmDay != null && isFinite(c.mmDay) ? c.mmDay.toFixed(2) : "—";
    var avgRd = c.rainDays != null && isFinite(c.rainDays) ? c.rainDays.toFixed(1) : "—";
    return (
      block("Average temperature", avgTemp, dTemp, 1, cellClass) +
      block("Rain (mm/day)", avgMm, dMm, 2, cellClassRain) +
      block("Rain days", avgRd, dRd, 1, cellClassRain)
    );
  }

  async function renderPeriodsProgressively(selectionData, refreshId) {
    var host = $("period-grid");
    host.innerHTML = "";
    for (var i = 0; i < selectionData.ranges.periodKeys.length; i++) {
      if (refreshId !== refreshNonce) return;
      var key = selectionData.ranges.periodKeys[i];
      var w = selectionData.ranges.windows[key];
      var rows = buildRowsForPeriod(selectionData, toISODateLocal(w.start), toISODateLocal(w.end));
      host.insertAdjacentHTML("beforeend", renderPeriodCard(key, w, rows));
      await yieldToBrowser();
    }
  }

  function scheduleDeferredRefresh(selectionData, refreshId) {
    (async function () {
      await yieldToBrowser();
      if (refreshId !== refreshNonce) return;
      try {
        await refreshChartsFromSelection(selectionData, refreshId);
      } catch (e) {
        if (refreshId !== refreshNonce) return;
        $("chart-forecast-note").textContent = e.message;
      }
    })();
  }

  async function refreshDashboard() {
    var refreshId = ++refreshNonce;
    latestSelectionData = null;

    var cities = getSelectedLocationObjects();
    var totalPoints = cities.length ? getTotalCityPoints(cities) : 0;
    $("filter-summary").textContent = cities.length
      ? "Averaging " + cities.length + " state" + (cities.length === 1 ? "" : "s") +
        " in " + (cities[0] && cities[0].countryName) +
        " (" + totalPoints + " city point" + (totalPoints === 1 ? "" : "s") + ")."
      : "Select at least one state.";

    if (!cities.length) {
      $("snapshot-grid").innerHTML = '<p class="muted">No states selected.</p>';
      $("period-grid").innerHTML = "";
      $("header-last-actual").textContent = "";
      $("chart-forecast-note").textContent = "";
      var k1 = $("chart-kpi-temp");
      var k2 = $("chart-kpi-precip");
      if (k1) k1.textContent = "";
      if (k2) k2.textContent = "";
      destroyChart(charts.temp);
      destroyChart(charts.dual);
      charts.temp = null;
      charts.dual = null;
      return;
    }

    var now = new Date();
    $("header-updated").textContent = "Updated: " + now.toLocaleString(undefined, { hour12: false });
    $("snapshot-grid").innerHTML = '<p class="loading">Loading snapshot…</p>';
    $("period-grid").innerHTML = '<p class="loading">Loading period tables…</p>';
    $("chart-forecast-note").textContent =
      "Charts load after the scorecards so the first view becomes usable sooner.";
    destroyChart(charts.temp);
    destroyChart(charts.dual);
    charts.temp = null;
    charts.dual = null;

    try {
      var selectionData = await loadSelectionData(cities, now);
      if (refreshId !== refreshNonce) return;
      latestSelectionData = selectionData;
      if (selectionData.sourceCounts.historical) {
        $("filter-summary").textContent +=
          " Historical baseline (LY + climatology) served from local database for " +
          selectionData.sourceCounts.historical +
          " state" +
          (selectionData.sourceCounts.historical === 1 ? "" : "s") +
          (selectionData.sourceCounts.live
            ? "; " + selectionData.sourceCounts.live + " still fall back to live API for baseline."
            : "; only current-year actuals fetched live.");
      } else if (selectionData.sourceCounts.live) {
        $("filter-summary").textContent +=
          " No local historical data for this country - all layers fetched live (slower).";
      }

      // Snapshot: rolling 7 days ending on the last day with actual data (yesterday),
      // consistent with the "Last actual" label and the MTD/YTD current-day definition.
      var lastActualDay = addDays(todayStart(), -1);
      var rollStart = addDays(lastActualDay, -6);
      var snapshotRollup = getRollupForRange(
        selectionData,
        toISODateLocal(rollStart),
        toISODateLocal(lastActualDay)
      );
      $("snapshot-grid").innerHTML = renderSnapshotGrid(snapshotRollup);
      var lastAct = addDays(todayStart(), -1);
      $("header-last-actual").textContent =
        "Last actual: " +
        lastAct.toLocaleDateString(undefined, { year: "numeric", month: "numeric", day: "numeric" });
      await yieldToBrowser();
      if (refreshId !== refreshNonce) return;

      await renderPeriodsProgressively(selectionData, refreshId);
      if (refreshId !== refreshNonce) return;
      scheduleDeferredRefresh(selectionData, refreshId);
    } catch (e) {
      if (refreshId !== refreshNonce) return;
      $("header-last-actual").textContent = "";
      var errText = escapeHtml(e && e.message ? e.message : String(e));
      $("snapshot-grid").innerHTML = '<p class="error-banner">' + errText + "</p>";
      $("period-grid").innerHTML = '<p class="error-banner">' + errText + "</p>";
    }
  }

  function getAlignedCurrentSeries(selectionData, startStr, endStr) {
    var cacheKey = "current|" + startStr + "|" + endStr;
    if (selectionData.alignedSeriesCache[cacheKey]) return selectionData.alignedSeriesCache[cacheKey];
    selectionData.alignedSeriesCache[cacheKey] = alignMeanSeries(selectionData.cities, function (city) {
      var record = selectionData.byId[city.id];
      if (!record || !record.currentSeries) return null;
      return sliceSeriesByDate(record.currentSeries, startStr, endStr);
    });
    return selectionData.alignedSeriesCache[cacheKey];
  }

  function climSeriesForRangeFromSelection(selectionData, startStr, endStr) {
    var cacheKey = "clim|" + startStr + "|" + endStr;
    if (selectionData.alignedSeriesCache[cacheKey]) return selectionData.alignedSeriesCache[cacheKey];

    var times = [];
    var t = [];
    var p = [];
    var s = parseISODate(startStr);
    var e = parseISODate(endStr);
    for (var d = new Date(s); d <= e; d = addDays(d, 1)) {
      var iso = toISODateLocal(d);
      var md = pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
      var mdk = md === "02-29" ? "02-28" : md;
      var tv = 0;
      var pv = 0;
      var n = 0;
      selectionData.cities.forEach(function (city) {
        var record = selectionData.byId[city.id];
        if (!record || !record.clim) return;
        if (record.clim.climTemp[mdk] != null) {
          tv += record.clim.climTemp[mdk];
          pv += record.clim.climPrecip[mdk] != null ? record.clim.climPrecip[mdk] : 0;
          n += 1;
        }
      });
      times.push(iso);
      t.push(n ? tv / n : null);
      p.push(n ? pv / n : null);
    }

    selectionData.alignedSeriesCache[cacheKey] = { time: times, tmean: t, precip: p };
    return selectionData.alignedSeriesCache[cacheKey];
  }

  function lySeriesAlignedFromSelection(selectionData, times) {
    if (!times.length) return { tmean: [], precip: [] };
    var cacheKey = "ly|" + times[0] + "|" + times[times.length - 1];
    if (selectionData.alignedSeriesCache[cacheKey]) return selectionData.alignedSeriesCache[cacheKey];

    var outT = [];
    var outP = [];
    for (var i = 0; i < times.length; i++) {
      var targetLy = shiftYears(times[i], -1);
      var sumsT = [];
      var sumsP = [];
      selectionData.cities.forEach(function (city) {
        var record = selectionData.byId[city.id];
        if (!record || !record.lySeries) return;
        var idx = record.lyIndex[targetLy];
        if (idx == null) return;
        var tm = dailyMeanTemp(record.lySeries.tmax, record.lySeries.tmin, idx);
        var pr = record.lySeries.precip[idx] != null ? record.lySeries.precip[idx] : 0;
        if (tm != null) sumsT.push(tm);
        sumsP.push(pr);
      });
      outT.push(sumsT.length ? sumsT.reduce(function (a, b) { return a + b; }, 0) / sumsT.length : null);
      outP.push(sumsP.length ? sumsP.reduce(function (a, b) { return a + b; }, 0) / sumsP.length : null);
    }

    selectionData.alignedSeriesCache[cacheKey] = { tmean: outT, precip: outP };
    return selectionData.alignedSeriesCache[cacheKey];
  }

  function formatPctVsBaselinePct(cur, base) {
    if (cur == null || base == null || !isFinite(cur) || !isFinite(base)) return "—";
    if (base === 0) return "—";
    var p = ((cur - base) / base) * 100;
    return (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
  }

  /**
   * Build the MTD / MTG / Full-month deltas shown above each chart.
   * Reuses the same period windows and roll-up logic as the scorecard tables
   * (getPeriodWindows + getRollupForRange) so the chart text always matches the
   * numbers in the MTD, MTG and Full Month Forecast cards.
   * `metric` is "meanTemp" or "mmDay"; baseline mode is read from the UI selector.
   */
  function buildChartKpiSummary(selectionData, metric) {
    var windows = selectionData.ranges.windows;
    var baselineMode = getComparisonBaselineMode();
    var baselineLabel = baselineMode === "his" ? "Hist" : "LY";

    function pickBase(rollup) {
      return baselineMode === "his" ? rollup.his : rollup.ly;
    }

    function pctForWindow(win) {
      if (!win) return "—";
      var rollup = getRollupForRange(
        selectionData,
        toISODateLocal(win.start),
        toISODateLocal(win.end)
      );
      var cur = rollup.current ? rollup.current[metric] : null;
      var base = pickBase(rollup);
      var baseVal = base ? base[metric] : null;
      return formatPctVsBaselinePct(cur, baseVal);
    }

    return (
      "MTD vs " + baselineLabel + " " +
      pctForWindow(windows.mtd) +
      " | MTG vs " + baselineLabel + " " +
      pctForWindow(windows.forecastMonth) +
      " | Full month vs " + baselineLabel + " " +
      pctForWindow(windows.fullMonthForecast)
    );
  }

  function splitActualForecastSeries(labels, values, lastActualStr) {
    var act = [];
    var fc = [];
    for (var i = 0; i < labels.length; i++) {
      var v = values[i];
      if (v == null || !isFinite(v)) {
        act.push(null);
        fc.push(null);
        continue;
      }
      if (labels[i] <= lastActualStr) {
        act.push(v);
        fc.push(null);
      } else {
        act.push(null);
        fc.push(v);
      }
    }
    return { actual: act, forecast: fc };
  }

  function lineDatasetCommon() {
    return {
      tension: 0.15,
      spanGaps: true,
      pointRadius: 0,
      pointHoverRadius: 5,
      hitRadius: 10,
    };
  }

  /** Tooltip: series values + Current year vs Baseline % (uses actual or forecast at index). */
  function buildLineChartInteractionOptions(baselineArr, splitActual, splitForecast, unit, dec) {
    return {
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          filter: function (ctx) {
            var y = ctx.parsed.y;
            return y != null && isFinite(y);
          },
          callbacks: {
            title: function (items) {
              return items.length ? String(items[0].label) : "";
            },
            label: function (ctx) {
              var v = ctx.parsed.y;
              if (v == null || !isFinite(v)) return "";
              var ds = ctx.dataset.label || "";
              return ds + ": " + v.toFixed(dec) + " " + unit;
            },
            afterBody: function (items) {
              if (!items.length) return [];
              var i = items[0].dataIndex;
              var b = baselineArr[i];
              var a = splitActual[i];
              var f = splitForecast[i];
              var cur = a != null && isFinite(a) ? a : f != null && isFinite(f) ? f : null;
              if (cur == null || b == null || !isFinite(cur) || !isFinite(b) || b === 0) return [];
              var p = ((cur - b) / b) * 100;
              var ps = (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
              return ["Current year vs Baseline: " + ps];
            },
          },
        },
        legend: { position: "bottom", labels: { color: CHART_LINE_ACTUAL } },
      },
    };
  }

  function renderOrUpdateChart(slot, canvasId, config) {
    if (charts[slot]) {
      charts[slot].data = config.data;
      charts[slot].options = config.options;
      charts[slot].update();
      return charts[slot];
    }
    charts[slot] = new Chart($(canvasId), config);
    return charts[slot];
  }

  async function refreshChartsFromSelection(selectionData, refreshId) {
    if (refreshId != null && refreshId !== refreshNonce) return;
    if (typeof window.Chart === "undefined") return;

    var startStr = selectionData.ranges.chart.startStr;
    var endStr = selectionData.ranges.chart.endStr;
    var merged = getAlignedCurrentSeries(selectionData, startStr, endStr);
    if (!merged.time.length) {
      var zk1 = $("chart-kpi-temp");
      var zk2 = $("chart-kpi-precip");
      if (zk1) zk1.textContent = "";
      if (zk2) zk2.textContent = "";
      destroyChart(charts.temp);
      destroyChart(charts.dual);
      charts.temp = null;
      charts.dual = null;
      return;
    }

    var baseline = getComparisonBaselineMode();
    var comp;
    if (baseline === "ly") {
      comp = lySeriesAlignedFromSelection(selectionData, merged.time);
    } else {
      comp = climSeriesForRangeFromSelection(selectionData, startStr, endStr);
    }

    var labels = merged.time;
    var actual = merged.tmean;
    var precip = merged.precip;
    var compLine = comp.tmean;
    var compPrecip = comp.precip;
    var lastActualStr = toISODateLocal(addDays(todayStart(), -1));
    var splitT = splitActualForecastSeries(labels, actual, lastActualStr);
    var splitP = splitActualForecastSeries(labels, precip, lastActualStr);
    var kpiT = $("chart-kpi-temp");
    var kpiP = $("chart-kpi-precip");
    if (kpiT) kpiT.textContent = buildChartKpiSummary(selectionData, "meanTemp");
    if (kpiP) kpiP.textContent = buildChartKpiSummary(selectionData, "mmDay");

    var dsTemp = [
      Object.assign({}, lineDatasetCommon(), {
        label: "Baseline",
        data: compLine,
        borderColor: CHART_LINE_BASELINE,
        borderWidth: 1,
      }),
      Object.assign({}, lineDatasetCommon(), {
        label: "Actual",
        data: splitT.actual,
        borderColor: CHART_LINE_ACTUAL,
        borderWidth: 2,
      }),
      Object.assign({}, lineDatasetCommon(), {
        label: "Forecast",
        data: splitT.forecast,
        borderColor: CHART_LINE_ACTUAL,
        borderWidth: 2,
        borderDash: [5, 5],
      }),
    ];

    renderOrUpdateChart("temp", "chart-temp", {
      type: "line",
      data: { labels: labels, datasets: dsTemp },
      options: Object.assign(
        {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { title: { display: true, text: "°C" }, ticks: { color: CHART_LINE_LY } },
            x: { ticks: { maxRotation: 0, autoSkip: true, color: CHART_LINE_LY } },
          },
        },
        buildLineChartInteractionOptions(compLine, splitT.actual, splitT.forecast, "°C", 2)
      ),
    });

    var dsPrecip = [
      Object.assign({}, lineDatasetCommon(), {
        label: "Baseline",
        data: compPrecip,
        borderColor: CHART_LINE_BASELINE,
        borderWidth: 1,
      }),
      Object.assign({}, lineDatasetCommon(), {
        label: "Actual",
        data: splitP.actual,
        borderColor: CHART_LINE_PRECIP,
        borderWidth: 2,
      }),
      Object.assign({}, lineDatasetCommon(), {
        label: "Forecast",
        data: splitP.forecast,
        borderColor: CHART_LINE_PRECIP,
        borderWidth: 2,
        borderDash: [5, 5],
      }),
    ];

    renderOrUpdateChart("dual", "chart-dual", {
      type: "line",
      data: { labels: labels, datasets: dsPrecip },
      options: Object.assign(
        {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { title: { display: true, text: "mm/d" }, ticks: { color: CHART_LINE_LY } },
            x: { ticks: { maxRotation: 0, autoSkip: true, color: CHART_LINE_LY } },
          },
        },
        buildLineChartInteractionOptions(compPrecip, splitP.actual, splitP.forecast, "mm/d", 2)
      ),
    });

    $("chart-forecast-note").textContent =
      "Forecast is limited to " +
      MAX_FORECAST_DAYS +
      " days on the public API; scorecards load first, then the charts reuse the same fetched series.";
  }

  function destroyChart(ch) {
    if (ch) ch.destroy();
  }

  function formatGeneratedAtShort(iso) {
    if (!iso) return "unknown";
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, { year: "numeric", month: "numeric", day: "numeric" });
    } catch (_e) {
      return iso;
    }
  }

  function renderHistoricalBanner() {
    var host = $("historical-banner");
    if (!host) return;
    var s = historicalDbStatus;
    if (!s || s.status === "ok") {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }

    var level = s.status === "missing" ? "error" : "warn";
    var title;
    var message;
    if (s.status === "missing") {
      title = "Historical database not found";
      message =
        "The dashboard is using slower live API calls for last year and climatology. " +
        "Click \"Update Historical Data\" to generate the local database.";
    } else {
      var parts = [];
      if (s.stale.length) {
        parts.push(
          s.stale.length + " country" + (s.stale.length === 1 ? "" : "ies") + " outdated"
        );
      }
      if (s.missing.length) {
        parts.push(
          s.missing.length + " country" + (s.missing.length === 1 ? "" : "ies") + " missing"
        );
      }
      title = "Historical data needs an update";
      message =
        parts.join(" and ") +
        ". Expected last year: " + s.expectedLyYear + ". Click \"Update Historical Data\" to refresh.";
    }

    host.hidden = false;
    host.className = "historical-banner historical-banner--" + level;
    host.innerHTML =
      '<div class="historical-banner__body">' +
      '<strong>' + escapeHtml(title) + '</strong> ' +
      '<span>' + escapeHtml(message) + '</span>' +
      '</div>' +
      '<div class="historical-banner__actions">' +
      '<button type="button" class="btn btn--sm" id="historical-banner-open">Update Historical Data</button>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="historical-banner-dismiss" aria-label="Dismiss">Dismiss</button>' +
      '</div>';

    var openBtn = $("historical-banner-open");
    if (openBtn) openBtn.addEventListener("click", openHistoricalModal);
    var dismissBtn = $("historical-banner-dismiss");
    if (dismissBtn) {
      dismissBtn.addEventListener("click", function () {
        host.hidden = true;
      });
    }
  }

  function renderHistoricalModal() {
    var modal = $("historical-modal");
    if (!modal) return;
    var body = $("historical-modal-body");
    if (!body) return;
    var s = historicalDbStatus;

    var sections = [];

    var overallStatus = s && s.status;
    var overallLabel =
      overallStatus === "ok" ? "Up to date" :
      overallStatus === "stale" ? "Update recommended" :
      "Not generated yet";
    var overallCls =
      overallStatus === "ok" ? "historical-status--ok" :
      overallStatus === "stale" ? "historical-status--warn" :
      "historical-status--error";
    sections.push(
      '<div class="historical-modal__summary">' +
        '<span class="historical-status ' + overallCls + '">' + escapeHtml(overallLabel) + '</span>' +
        '<p class="muted tiny">Expected last year: <strong>' + (s ? s.expectedLyYear : "—") + '</strong>. ' +
        'Expected climatology: <strong>' + (s && s.expectedClim ? s.expectedClim.startYear + "-" + s.expectedClim.endYear : "—") + '</strong>.</p>' +
      '</div>'
    );

    var rows = [];
    (s && s.fresh ? s.fresh : []).forEach(function (entry) {
      rows.push(
        '<tr><td>' + escapeHtml(entry.label) + '</td>' +
        '<td><span class="historical-status historical-status--ok">Up to date</span></td>' +
        '<td>' + escapeHtml(String(entry.lyYear)) + '</td>' +
        '<td>' + escapeHtml(formatGeneratedAtShort(entry.generatedAt)) + '</td></tr>'
      );
    });
    (s && s.stale ? s.stale : []).forEach(function (entry) {
      rows.push(
        '<tr><td>' + escapeHtml(entry.label) + '</td>' +
        '<td><span class="historical-status historical-status--warn">Outdated</span><br><span class="muted tiny">' + escapeHtml(entry.reason || "") + '</span></td>' +
        '<td>' + escapeHtml(String(entry.lyYear)) + '</td>' +
        '<td>' + escapeHtml(formatGeneratedAtShort(entry.generatedAt)) + '</td></tr>'
      );
    });
    (s && s.missing ? s.missing : []).forEach(function (entry) {
      rows.push(
        '<tr><td>' + escapeHtml(entry.label) + '</td>' +
        '<td><span class="historical-status historical-status--error">Missing</span></td>' +
        '<td>—</td><td>—</td></tr>'
      );
    });

    if (rows.length) {
      sections.push(
        '<div class="table-wrap"><table class="score-table historical-modal__table">' +
        '<thead><tr><th>Country</th><th>Status</th><th>LY year</th><th>Generated</th></tr></thead>' +
        '<tbody>' + rows.join("") + '</tbody></table></div>'
      );
    }

    sections.push(
      '<div class="historical-modal__instructions">' +
        '<h3>How to update</h3>' +
        '<ol>' +
          '<li>In the project folder, double-click <code>update-historical.bat</code>.</li>' +
          '<li>A window opens showing progress. Wait for it to finish (a few minutes).</li>' +
          '<li>Close that window, then <strong>reload this page</strong>.</li>' +
        '</ol>' +
        '<p class="muted tiny">Tip: The generator uses Open-Meteo. If the daily API limit is reached, try again the next day.</p>' +
      '</div>'
    );

    body.innerHTML = sections.join("");
  }

  function openHistoricalModal() {
    var modal = $("historical-modal");
    if (!modal) return;
    renderHistoricalModal();
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    var closeBtn = $("historical-modal-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeHistoricalModal() {
    var modal = $("historical-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  function wireHistoricalUi() {
    var openBtn = $("btn-update-historical");
    if (openBtn) openBtn.addEventListener("click", openHistoricalModal);
    var closeBtn = $("historical-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", closeHistoricalModal);
    var modal = $("historical-modal");
    if (modal) {
      modal.addEventListener("click", function (e) {
        if (e.target === modal) closeHistoricalModal();
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeHistoricalModal();
    });
  }

  function wireEvents() {
    $("filter-country").addEventListener("change", function () {
      syncFiltersFromCountry();
      refreshDashboard();
    });

    function bindDropdownTrigger(rootId) {
      var root = $(rootId);
      if (!root) return;
      var trig = root.querySelector(".filter-dropdown__trigger");
      if (!trig) return;
      trig.addEventListener("mousedown", function (e) {
        e.stopPropagation();
      });
      trig.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleFilterDropdown(rootId);
      });
    }
    bindDropdownTrigger("filter-region-root");
    bindDropdownTrigger("filter-state-root");

    $("filter-region-list").addEventListener("change", function () {
      updateRegionTriggerLabel();
      if (getSelectedRegionIds().length === 0) {
        setAllRegionCheckboxes(true);
        updateRegionTriggerLabel();
      }
      refillStateOptions(true);
      refreshDashboard();
    });
    $("filter-state-list").addEventListener("change", function () {
      updateStateTriggerLabel();
      refreshDashboard();
    });

    $("filter-region-all").addEventListener("click", function (e) {
      e.stopPropagation();
      setAllRegionCheckboxes(true);
      refillStateOptions(true);
      refreshDashboard();
    });
    $("filter-region-clear").addEventListener("click", function (e) {
      e.stopPropagation();
      setAllRegionCheckboxes(false);
      if (getSelectedRegionIds().length === 0) {
        setAllRegionCheckboxes(true);
        updateRegionTriggerLabel();
      }
      refillStateOptions(true);
      refreshDashboard();
    });
    $("filter-state-all").addEventListener("click", function (e) {
      e.stopPropagation();
      setAllStateCheckboxes(true);
      updateStateTriggerLabel();
      refreshDashboard();
    });
    $("filter-state-clear").addEventListener("click", function (e) {
      e.stopPropagation();
      setAllStateCheckboxes(false);
      updateStateTriggerLabel();
      refreshDashboard();
    });

    $("btn-select-all-states").addEventListener("click", function () {
      setAllStateCheckboxes(true);
      refreshDashboard();
    });
    $("btn-clear").addEventListener("click", function () {
      setAllStateCheckboxes(false);
      refreshDashboard();
    });

    document.addEventListener("click", function (e) {
      if (!e.target.closest || !e.target.closest(".filter-dropdown")) {
        closeAllFilterDropdowns();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAllFilterDropdowns();
    });

    function onBaselineChange(e) {
      var v = e.target && e.target.value ? e.target.value : getComparisonBaselineMode();
      syncBaselineSelects(v);
      if (latestSelectionData) {
        renderPeriodGridSync(latestSelectionData);
        refreshChartsFromSelection(latestSelectionData, refreshNonce);
      }
    }
    $("chart-baseline").addEventListener("change", onBaselineChange);
    var pb = $("period-baseline");
    if (pb) pb.addEventListener("change", onBaselineChange);
  }

  /* --------------------------------------------------------------------- */
  /* CSV Export: modal with independent filters + custom date range.       */
  /* Reuses fetchMergedDailyForCity so archive + forecast and caching      */
  /* behave exactly like the dashboard's main data pipeline.               */
  /* --------------------------------------------------------------------- */

  var exportBusy = false;

  function populateExportCountrySelect() {
    var sel = $("export-country");
    if (!sel || !locationsData) return;
    sel.innerHTML = "";
    locationsData.countries.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      sel.appendChild(o);
    });
  }

  function getExportSelectedRegionIds() {
    return getCheckedIdsFromList($("export-region-list"));
  }

  function getExportSelectedStateIds() {
    return getCheckedIdsFromList($("export-state-list"));
  }

  function updateExportRegionTriggerLabel() {
    var list = $("export-region-list");
    var trig = $("export-region-trigger");
    if (!list || !trig) return;
    var boxes = list.querySelectorAll('input[type="checkbox"]');
    var n = boxes.length;
    var c = 0;
    boxes.forEach(function (b) {
      if (b.checked) c += 1;
    });
    if (!n) {
      trig.textContent = "—";
      return;
    }
    if (c === 0) {
      trig.textContent = "All regions (scope)";
      return;
    }
    if (c === n) {
      trig.textContent = "All regions (" + n + ")";
      return;
    }
    trig.textContent = c + " region" + (c === 1 ? "" : "s");
  }

  function updateExportStateTriggerLabel() {
    var list = $("export-state-list");
    var trig = $("export-state-trigger");
    if (!list || !trig) return;
    var boxes = list.querySelectorAll('input[type="checkbox"]');
    var n = boxes.length;
    var c = 0;
    boxes.forEach(function (b) {
      if (b.checked) c += 1;
    });
    if (!n) {
      trig.textContent = "—";
      return;
    }
    if (c === 0) {
      trig.textContent = "No states";
      return;
    }
    if (c === n) {
      trig.textContent = "All states (" + n + ")";
      return;
    }
    trig.textContent = c + " state" + (c === 1 ? "" : "s");
  }

  function setAllExportRegionCheckboxes(checked) {
    var list = $("export-region-list");
    if (!list) return;
    list.querySelectorAll('input[type="checkbox"]').forEach(function (inp) {
      inp.checked = checked;
    });
    updateExportRegionTriggerLabel();
  }

  function setAllExportStateCheckboxes(checked) {
    var list = $("export-state-list");
    if (!list) return;
    list.querySelectorAll('input[type="checkbox"]').forEach(function (inp) {
      inp.checked = checked;
    });
    updateExportStateTriggerLabel();
  }

  function refillExportStateOptions(selectAllWhenEmpty) {
    var countryId = $("export-country").value;
    var regionIds = getExportSelectedRegionIds();
    var stList = $("export-state-list");
    if (!stList) return;
    var prevStates = [];
    stList.querySelectorAll('input[name="export-state"]').forEach(function (inp) {
      if (inp.checked) prevStates.push(inp.value);
    });
    var states = listStatesForRegions(countryId, regionIds);
    stList.innerHTML = "";
    states.forEach(function (s) {
      var lab = document.createElement("label");
      lab.className = "filter-dropdown__item";
      var inp = document.createElement("input");
      inp.type = "checkbox";
      inp.name = "export-state";
      inp.value = s.id;
      inp.checked = (selectAllWhenEmpty && !prevStates.length) || prevStates.indexOf(s.id) !== -1;
      var span = document.createElement("span");
      span.textContent = s.name;
      lab.appendChild(inp);
      lab.appendChild(span);
      stList.appendChild(lab);
    });
    var nChecked = 0;
    stList.querySelectorAll('input[name="export-state"]').forEach(function (inp) {
      if (inp.checked) nChecked += 1;
    });
    if (nChecked === 0) {
      setAllExportStateCheckboxes(true);
    }
    updateExportStateTriggerLabel();
  }

  function syncExportFiltersFromCountry() {
    var cid = $("export-country").value;
    var country = getCountryById(cid);
    var regList = $("export-region-list");
    var stList = $("export-state-list");
    if (regList) regList.innerHTML = "";
    if (stList) stList.innerHTML = "";
    if (!country) {
      updateExportRegionTriggerLabel();
      updateExportStateTriggerLabel();
      return;
    }
    country.regions.forEach(function (r) {
      var lab = document.createElement("label");
      lab.className = "filter-dropdown__item";
      var inp = document.createElement("input");
      inp.type = "checkbox";
      inp.name = "export-region";
      inp.value = r.id;
      inp.checked = true;
      var span = document.createElement("span");
      span.textContent = r.name;
      lab.appendChild(inp);
      lab.appendChild(span);
      regList.appendChild(lab);
    });
    updateExportRegionTriggerLabel();
    refillExportStateOptions(true);
  }

  function getExportSelectedStates() {
    var countryId = $("export-country").value;
    var regionIds = getExportSelectedRegionIds();
    var stateIds = getExportSelectedStateIds();
    if (!countryId || !stateIds.length) return [];
    var pool = listStatesForFilters(countryId, regionIds);
    return pool.filter(function (s) {
      return stateIds.indexOf(s.id) !== -1;
    });
  }

  function getExportSelectedCities() {
    var states = getExportSelectedStates();
    var cities = [];
    states.forEach(function (st) {
      var cs = getCitiesForState(st.stateId || st.id);
      if (cs.length) {
        cs.forEach(function (c) { cities.push(c); });
      }
    });
    return cities;
  }

  function updateExportSummary() {
    var summary = $("export-summary");
    if (!summary) return;
    var cities = getExportSelectedCities();
    var states = getExportSelectedStates();
    var start = $("export-start-date").value;
    var end = $("export-end-date").value;
    var parts = [];
    if (!cities.length) {
      parts.push("Select at least one state.");
    } else {
      parts.push(
        "Scope: " + states.length + " state" + (states.length === 1 ? "" : "s") +
        ", " + cities.length + " city point" + (cities.length === 1 ? "" : "s") + "."
      );
    }
    if (start && end) {
      if (start > end) {
        parts.push("Start date must be on or before end date.");
      } else {
        var ndays = Math.round(
          (parseISODate(end).getTime() - parseISODate(start).getTime()) / 86400000
        ) + 1;
        parts.push("Range: " + ndays + " day" + (ndays === 1 ? "" : "s") + ".");
      }
    } else {
      parts.push("Pick a start and end date.");
    }
    summary.textContent = parts.join(" ");
    updateExportDownloadEnabled();
  }

  function updateExportDownloadEnabled() {
    var btn = $("export-download");
    if (!btn) return;
    if (exportBusy) {
      btn.disabled = true;
      return;
    }
    var cities = getExportSelectedCities();
    var start = $("export-start-date").value;
    var end = $("export-end-date").value;
    var valid = cities.length > 0 && !!start && !!end && start <= end;
    btn.disabled = !valid;
  }

  function setExportError(msg) {
    var el = $("export-error");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
    } else {
      el.hidden = false;
      el.textContent = msg;
    }
  }

  function setExportProgress(msg) {
    var el = $("export-progress");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
    } else {
      el.hidden = false;
      el.textContent = msg;
    }
  }

  /** CSV-safe cell: wrap in quotes if needed, double internal quotes. */
  function csvCell(v) {
    if (v == null) return "";
    var s = String(v);
    if (s.indexOf('"') !== -1 || s.indexOf(",") !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function numCell(n, decimals) {
    if (n == null || !isFinite(n)) return "";
    return Number(n).toFixed(decimals);
  }

  async function runCsvExport() {
    if (exportBusy) return;
    setExportError("");

    var cities = getExportSelectedCities();
    var startStr = $("export-start-date").value;
    var endStr = $("export-end-date").value;

    if (!cities.length) {
      setExportError("Select at least one state.");
      return;
    }
    if (!startStr || !endStr) {
      setExportError("Pick a start and end date.");
      return;
    }
    if (startStr > endStr) {
      setExportError("Start date must be on or before end date.");
      return;
    }

    var todayStr = toISODateLocal(todayStart());
    var maxFutureStr = toISODateLocal(addDays(todayStart(), MAX_FORECAST_DAYS));
    if (endStr > maxFutureStr) {
      setExportError(
        "End date is beyond the forecast horizon (max " + MAX_FORECAST_DAYS +
        " days ahead, so " + maxFutureStr + ")."
      );
      return;
    }

    var rangeDays = Math.round(
      (parseISODate(endStr).getTime() - parseISODate(startStr).getTime()) / 86400000
    ) + 1;
    if (rangeDays > 366) {
      var ok = window.confirm(
        "You selected " + rangeDays + " days across " + cities.length + " cities. " +
        "This will issue many API calls and may be throttled by Open-Meteo. Continue?"
      );
      if (!ok) return;
    }

    exportBusy = true;
    updateExportDownloadEnabled();
    var cancelBtn = $("export-cancel");
    if (cancelBtn) cancelBtn.disabled = true;

    try {
      var results = new Array(cities.length);
      var done = 0;
      setExportProgress("Fetching data for " + cities.length + " cities…");

      await Promise.all(cities.map(function (city, i) {
        return fetchMergedDailyForCity(city, startStr, endStr)
          .then(function (series) {
            results[i] = { city: city, series: series, error: null };
          })
          .catch(function (err) {
            results[i] = { city: city, series: null, error: err && err.message ? err.message : String(err) };
          })
          .then(function () {
            done += 1;
            setExportProgress("Fetched " + done + " of " + cities.length + " cities…");
          });
      }));

      setExportProgress("Building CSV…");

      var header = [
        "date",
        "country",
        "region",
        "state",
        "city",
        "latitude",
        "longitude",
        "temp_max_C",
        "temp_min_C",
        "temp_mean_C",
        "precipitation_mm",
      ];
      var lines = [header.join(",")];

      var errors = [];
      results.forEach(function (r) {
        if (!r) return;
        if (r.error || !r.series) {
          errors.push(r.city.name + ": " + (r.error || "no data"));
          return;
        }
        var s = r.series;
        var times = s.time || [];
        for (var i = 0; i < times.length; i++) {
          var d = times[i];
          if (d < startStr || d > endStr) continue;
          var tmax = s.tmax && s.tmax[i] != null ? s.tmax[i] : null;
          var tmin = s.tmin && s.tmin[i] != null ? s.tmin[i] : null;
          var tmean = tmax != null && tmin != null ? (tmax + tmin) / 2 : null;
          var prcp = s.precip && s.precip[i] != null ? s.precip[i] : null;
          lines.push([
            csvCell(d),
            csvCell(r.city.countryName),
            csvCell(r.city.regionName),
            csvCell(r.city.stateName),
            csvCell(r.city.name),
            numCell(r.city.latitude, 4),
            numCell(r.city.longitude, 4),
            numCell(tmax, 1),
            numCell(tmin, 1),
            numCell(tmean, 2),
            numCell(prcp, 2),
          ].join(","));
        }
      });

      if (lines.length <= 1) {
        setExportError(
          "No data returned for the selected scope/range" +
          (errors.length ? " (" + errors.slice(0, 3).join("; ") + ")" : "") + "."
        );
        return;
      }

      // Prepend UTF-8 BOM so Excel opens accented characters correctly.
      var csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var countryId = cities[0].countryId;
      var country = getCountryById(countryId);
      var countrySlug = country && country.name
        ? country.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        : countryId;
      var filename = "weather-data_" + countrySlug + "_" + startStr + "_to_" + endStr + ".csv";
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

      var dataRows = lines.length - 1;
      var msg = "Downloaded " + dataRows + " row" + (dataRows === 1 ? "" : "s") + " (" + filename + ").";
      if (errors.length) {
        msg += " " + errors.length + " city"  + (errors.length === 1 ? "" : "ies") + " had errors and were skipped.";
      }
      setExportProgress(msg);
    } catch (err) {
      setExportError("Export failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      exportBusy = false;
      if (cancelBtn) cancelBtn.disabled = false;
      updateExportDownloadEnabled();
    }
  }

  function openExportModal() {
    var modal = $("export-modal");
    if (!modal) return;
    setExportError("");
    setExportProgress("");

    // Pre-fill country from the main dashboard filter if possible.
    var mainCountry = $("filter-country").value;
    var sel = $("export-country");
    if (sel && mainCountry) sel.value = mainCountry;
    syncExportFiltersFromCountry();
    setAllExportStateCheckboxes(true);

    // Default date range: last 30 days ending today.
    var end = todayStart();
    var start = addDays(end, -29);
    var startInput = $("export-start-date");
    var endInput = $("export-end-date");
    if (startInput && !startInput.value) startInput.value = toISODateLocal(start);
    if (endInput && !endInput.value) endInput.value = toISODateLocal(end);
    // Cap end to forecast horizon.
    if (endInput) {
      endInput.max = toISODateLocal(addDays(todayStart(), MAX_FORECAST_DAYS));
    }

    updateExportSummary();

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    var closeBtn = $("export-modal-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeExportModal() {
    var modal = $("export-modal");
    if (!modal) return;
    if (exportBusy) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    closeAllFilterDropdowns();
  }

  function wireExportUi() {
    var openBtn = $("btn-open-export");
    if (openBtn) openBtn.addEventListener("click", openExportModal);

    var closeBtn = $("export-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", closeExportModal);

    var cancelBtn = $("export-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", closeExportModal);

    var modal = $("export-modal");
    if (modal) {
      modal.addEventListener("click", function (e) {
        if (e.target === modal) closeExportModal();
        if (e.target && e.target.classList && e.target.classList.contains("historical-modal__backdrop")) {
          closeExportModal();
        }
      });
    }

    populateExportCountrySelect();
    syncExportFiltersFromCountry();

    $("export-country").addEventListener("change", function () {
      syncExportFiltersFromCountry();
      updateExportSummary();
    });

    function bindExportDropdownTrigger(rootId) {
      var root = $(rootId);
      if (!root) return;
      var trig = root.querySelector(".filter-dropdown__trigger");
      if (!trig) return;
      trig.addEventListener("mousedown", function (e) { e.stopPropagation(); });
      trig.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleFilterDropdown(rootId);
      });
    }
    bindExportDropdownTrigger("export-region-root");
    bindExportDropdownTrigger("export-state-root");

    $("export-region-list").addEventListener("change", function () {
      updateExportRegionTriggerLabel();
      if (getExportSelectedRegionIds().length === 0) {
        setAllExportRegionCheckboxes(true);
        updateExportRegionTriggerLabel();
      }
      refillExportStateOptions(true);
      updateExportSummary();
    });
    $("export-state-list").addEventListener("change", function () {
      updateExportStateTriggerLabel();
      updateExportSummary();
    });

    $("export-region-all").addEventListener("click", function (e) {
      e.stopPropagation();
      setAllExportRegionCheckboxes(true);
      refillExportStateOptions(true);
      updateExportSummary();
    });
    $("export-region-clear").addEventListener("click", function (e) {
      e.stopPropagation();
      setAllExportRegionCheckboxes(false);
      if (getExportSelectedRegionIds().length === 0) {
        setAllExportRegionCheckboxes(true);
        updateExportRegionTriggerLabel();
      }
      refillExportStateOptions(true);
      updateExportSummary();
    });
    $("export-state-all").addEventListener("click", function (e) {
      e.stopPropagation();
      setAllExportStateCheckboxes(true);
      updateExportStateTriggerLabel();
      updateExportSummary();
    });
    $("export-state-clear").addEventListener("click", function (e) {
      e.stopPropagation();
      setAllExportStateCheckboxes(false);
      updateExportStateTriggerLabel();
      updateExportSummary();
    });

    $("export-start-date").addEventListener("change", updateExportSummary);
    $("export-end-date").addEventListener("change", updateExportSummary);

    $("export-download").addEventListener("click", runCsvExport);

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var m = $("export-modal");
      if (m && !m.hidden) closeExportModal();
    });
  }

  async function boot() {
    $("rain-threshold-label").textContent = String(RAIN_MM);
    var cw = getClimatologyYearWindow();
    $("clim-label").textContent = cw.startYear + "–" + cw.endYear;
    $("clim-years-count").textContent = String(CLIM_FULL_YEARS);
    var cacheNote = $("clim-cache-note");
    if (cacheNote) {
      cacheNote.textContent =
        "Last year and climatology load instantly from the local historical database. " +
        "Update it with the \"Update Historical Data\" button when a new calendar year begins.";
    }
    await loadLocations();
    populateCountrySelect();
    // Optional ?country=<id> URL param lets a parent page (e.g. an embedding iframe
    // in the Country Manager Dashboard) preselect a country other than the first.
    try {
      var params = new URLSearchParams(window.location.search || "");
      var initialCountry = (params.get("country") || "").toLowerCase();
      if (initialCountry) {
        var sel = $("filter-country");
        var hasOption = false;
        for (var i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value === initialCountry) { hasOption = true; break; }
        }
        if (hasOption) sel.value = initialCountry;
      }
    } catch (_e) { /* URLSearchParams unsupported — keep default selection. */ }
    syncFiltersFromCountry();
    setAllStateCheckboxes(true);
    syncBaselineSelects($("chart-baseline").value);
    wireEvents();
    wireHistoricalUi();
    wireExportUi();
    // Evaluate the historical DB and show the stale-data banner before the first refresh.
    try {
      await getHistoricalDbStatus();
    } catch (_e) {
      // Non-fatal — the banner just stays hidden.
    }
    renderHistoricalBanner();
    await refreshDashboard();
  }

  boot().catch(function (err) {
    var msg = escapeHtml(err && err.message ? err.message : String(err));
    document.body.innerHTML =
      '<p class="error-banner" style="margin:2rem">Failed to start: ' +
      msg +
      ". If you see this after opening index.html directly, ensure <code>data/locations-data.js</code> exists next to index.html and reload.</p>";
  });
})();
