import {
  CONFIG,
  cumulativeDistances,
  indexAtFraction,
  buildDistanceBasedCheckpoints,
  evaluate,
} from './matching.js';

const MAPS_API_KEY =
  'AIzaSyD0eZEFoMe7LGmHlgbSDrPJz0JkFlI19_M';
const AUTH_PASSWORD = 'visions';

const CAR_A_INITIAL_PROGRESS = 0.35;
const STEP_MS = 500;
const BASE_STEP_SEC = 5;

const authElements = {
  screen: document.getElementById('auth-screen'),
  form: document.getElementById('auth-form'),
  input: document.getElementById('password-input'),
  error: document.getElementById('auth-error'),
};

function setAuthError(message) {
  if (!authElements.error) {
    return;
  }

  authElements.error.textContent = message;
}

function handleAuthSubmit(event) {
  event.preventDefault();

  const inputValue = authElements.input?.value.trim() ?? '';

  if (!inputValue) {
    setAuthError('パスワードを入力してください。');
    authElements.input?.focus();
    return;
  }

  if (inputValue !== AUTH_PASSWORD) {
    setAuthError('パスワードが違います。');
    authElements.input?.focus();
    authElements.input?.select();
    return;
  }

  document.body.classList.add('authenticated');
  setAuthError('');
  main();
}

const $ = id =>
  document.getElementById(id);

const el = {
  status: $('status-pill'),
  generate: $('generate-btn'),
  start: $('start-btn'),
  pause: $('pause-btn'),
  reset: $('reset-btn'),
  speed: $('speed-select'),

  originInput: $('origin-input'),
  destinationInput: $('destination-input'),

  origin: $('origin-value'),
  destination: $('destination-value'),
  routeDistance: $('route-distance'),
  divisionCount: $('division-count'),
  checkpointCount: $('checkpoint-count'),

  simTime: $('sim-time'),
  aProgress: $('a-progress'),
  aPosition: $('a-position'),
  matchCount: $('match-count'),
  bestScore: $('best-score'),

  checkpointList: $('checkpoint-list'),
  candidateList: $('candidate-list'),
  vehicleDetail: $('vehicle-detail'),
  parameterInfo: $('parameter-info'),
  themeToggle: $('theme-toggle-btn'),
  panelClose: $('panel-close-btn'),
  panelOpen: $('panel-open-btn'),
};

const typeNames = {
  leading_same_route: '同一経路・先行車',
  trailing_same_route: '同一経路・後続車',
  merge_midway: '途中合流車',
  leave_midway: '途中離脱車',
  unrelated: '無関係車',
};

let map;
let directionsService;
let directionsRenderer;
let originAutocomplete;
let destinationAutocomplete;

let route = [];
let baseCum = [];
let routeDurationSeconds = 0;
let checkpoints = [];
let divisions = 0;
let userA = null;

let elapsed = 0;
let timer = null;

let aMarker = null;
let originMarker = null;
let destinationMarker = null;
let cpMarkers = [];

const states = new Map();
const candidateMarkers = new Map();
const candidateLines = new Map();
const commonCpHighlights = new Map();

function setStatus(
  message,
  error = false
) {
  el.status.textContent = message;
  el.status.classList.toggle(
    'error',
    error
  );
}

function latLngObject(point) {
  if (Array.isArray(point)) {
    return {
      lat: Number(point[0]),
      lng: Number(point[1]),
    };
  }

  if (typeof point.lat === 'function') {
    return {
      lat: point.lat(),
      lng: point.lng(),
    };
  }

  return {
    lat: Number(point.lat),
    lng: Number(point.lng),
  };
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch])
  );
}

const f3 = value =>
  Number.isFinite(value)
    ? value.toFixed(3)
    : '—';

const fm = value =>
  Number.isFinite(value)
    ? `${value.toFixed(2)} 分`
    : '—';

const fk = value =>
  Number.isFinite(value)
    ? `${value.toFixed(3)} km`
    : '—';

function markerIcon(
  color,
  scale = 8
) {
  return {
    path:
      google.maps.SymbolPath.CIRCLE,

    scale,

    fillColor:
      color,

    fillOpacity:
      1,

    strokeColor:
      '#ffffff',

    strokeWeight:
      2,
  };
}

async function loadGoogleMaps() {
  await new Promise(
    (resolve, reject) => {
      window.initDriveriaMap =
        resolve;

      const script =
        document.createElement(
          'script'
        );

      script.src =
        `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_API_KEY)}&libraries=geometry,places&callback=initDriveriaMap`;

      script.async = true;
      script.defer = true;

      script.onerror =
        () => reject(
          new Error(
            'Google Maps API の読み込みに失敗しました．'
          )
        );

      document.head.appendChild(
        script
      );
    }
  );
}

function initMap() {
  map =
    new google.maps.Map(
      $('map'),
      {
        center: {
          lat: 35.69,
          lng: 139.48,
        },

        zoom: 13,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: true,
      }
    );

  directionsService =
    new google.maps.DirectionsService();

  directionsRenderer =
    new google.maps.DirectionsRenderer({
      map,

      suppressMarkers:
        true,

      polylineOptions: {
        strokeColor:
          '#00a8ff',

        strokeOpacity:
          0.95,

        strokeWeight:
          6,

        zIndex:
          30,
      },
    });

  originAutocomplete =
    new google.maps.places.Autocomplete(
      el.originInput,
      {
        fields: [
          'geometry',
          'name',
          'formatted_address',
        ],
      }
    );

  destinationAutocomplete =
    new google.maps.places.Autocomplete(
      el.destinationInput,
      {
        fields: [
          'geometry',
          'name',
          'formatted_address',
        ],
      }
    );
}

function requestGoogleRoute() {
  const originText =
    el.originInput.value.trim();

  const destinationText =
    el.destinationInput.value.trim();

  if (!originText || !destinationText) {
    throw new Error(
      '出発地と目的地を入力してください．'
    );
  }

  const originPlace =
    originAutocomplete?.getPlace();

  const destinationPlace =
    destinationAutocomplete?.getPlace();

  const origin =
    originPlace?.geometry?.location
    || originText;

  const destination =
    destinationPlace?.geometry?.location
    || destinationText;

  return new Promise(
    (resolve, reject) => {
      directionsService.route(
        {
          origin,
          destination,

          travelMode:
            google.maps.TravelMode.DRIVING,

          provideRouteAlternatives:
            false,
        },

        (
          result,
          status
        ) => {
          if (
            status !== 'OK'
            ||
            !result?.routes?.length
          ) {
            reject(
              new Error(
                `Directions API: ${status}`
              )
            );

            return;
          }

          resolve(result);
        }
      );
    }
  );
}

function sampleRoute(
  path,
  targetSpacingMeters = 40
) {
  const sampled = [
    latLngObject(path[0]),
  ];

  for (
    let i = 1;
    i < path.length;
    i += 1
  ) {
    const a = path[i - 1];
    const b = path[i];

    const distance =
      google.maps.geometry
        .spherical
        .computeDistanceBetween(
          a,
          b
        );

    const pieces =
      Math.max(
        1,
        Math.ceil(
          distance
          / targetSpacingMeters
        )
      );

    for (
      let j = 1;
      j <= pieces;
      j += 1
    ) {
      sampled.push(
        latLngObject(
          google.maps.geometry
            .spherical
            .interpolate(
              a,
              b,
              j / pieces
            )
        )
      );
    }
  }

  return sampled;
}

/**
 * Make a route visually different before/after the shared segment.
 *
 * This is an experimental visual generator:
 * - merge: separate route before joining A
 * - leave: separate route after leaving A
 * - unrelated: entirely offset from A
 */
function offsetRoute(
  baseRoute,
  mode,
  startIndex,
  endIndex,
  latOffset,
  lngOffset
) {
  const n =
    Math.max(
      1,
      baseRoute.length - 1
    );

  return baseRoute.map(
    (
      point,
      index
    ) => {
      let factor = 0;

      if (
        mode === 'merge'
        &&
        index < startIndex
      ) {
        const t =
          index
          / Math.max(
            1,
            startIndex
          );

        factor =
          1 - t;

      } else if (
        mode === 'leave'
        &&
        index > endIndex
      ) {
        const t =
          (
            index
            - endIndex
          )
          / Math.max(
            1,
            n - endIndex
          );

        factor = t;

      } else if (
        mode === 'unrelated'
      ) {
        factor = 1;
      }

      return {
        lat:
          point.lat
          + latOffset * factor,

        lng:
          point.lng
          + lngOffset * factor,
      };
    }
  );
}

function makeCandidate({
  id,
  group,
progress,
  etaOffsetMin,
  sharedStartFraction,
  sharedEndFraction,
  mode = 'same',
  latOffset = 0,
  lngOffset = 0,
}) {
  const startIndex =
    sharedStartFraction == null
      ? null
      : indexAtFraction(
          baseCum,
          sharedStartFraction
        );

  const endIndex =
    sharedEndFraction == null
      ? null
      : indexAtFraction(
          baseCum,
          sharedEndFraction
        );

  let candidateRoute;

  if (mode === 'same') {
    candidateRoute =
      route.map(
        point => ({
          ...point,
        })
      );
  } else {
    candidateRoute =
      offsetRoute(
        route,
        mode,
        startIndex ?? 0,
        endIndex ?? route.length - 1,
        latOffset,
        lngOffset
      );
  }

  const candidateCum =
    cumulativeDistances(
      candidateRoute
    );

  const initialIndex =
    indexAtFraction(
      candidateCum,
      progress
    );

  const initialRemainingEtaSeconds =
    Math.max(
      120,
      userA.initialRemainingEtaSeconds
      + etaOffsetMin * 60
    );

  return {
    id,
    group,
route:
      candidateRoute,

    sharedRange:
      (
        startIndex == null
        ||
        endIndex == null
      )
        ? null
        : {
            startIndex,
            endIndex,
          },

    initialIndex,
    currentIndex:
      initialIndex,

    initialRemainingEtaSeconds,
  };
}

function buildCandidates() {
  states.clear();

  const definitions = [
    {
      id:'user1',
      group:'leading_same_route',
      progress:.43,
      etaOffsetMin:-3.0,
      sharedStartFraction:0,
      sharedEndFraction:1,
      mode:'same',
    },
    {
      id:'user2',
      group:'leading_same_route',
      progress:.47,
      etaOffsetMin:-4.5,
      sharedStartFraction:0,
      sharedEndFraction:1,
      mode:'same',
    },
    {
      id:'user3',
      group:'leading_same_route',
      progress:.51,
      etaOffsetMin:-6.0,
      sharedStartFraction:0,
      sharedEndFraction:1,
      mode:'same',
    },

    {
      id:'user4',
      group:'trailing_same_route',
      progress:.30,
      etaOffsetMin:3.0,
      sharedStartFraction:0,
      sharedEndFraction:1,
      mode:'same',
    },
    {
      id:'user5',
      group:'trailing_same_route',
      progress:.27,
      etaOffsetMin:5.0,
      sharedStartFraction:0,
      sharedEndFraction:1,
      mode:'same',
    },

    {
      id:'user6',
      group:'merge_midway',
      progress:.34,
      etaOffsetMin:-2.0,
      sharedStartFraction:.45,
      sharedEndFraction:1,
      mode:'merge',
      latOffset:.006,
      lngOffset:-.005,
    },
    {
      id:'user7',
      group:'merge_midway',
      progress:.32,
      etaOffsetMin:2.0,
      sharedStartFraction:.55,
      sharedEndFraction:1,
      mode:'merge',
      latOffset:-.006,
      lngOffset:.005,
    },

    {
      id:'user8',
      group:'leave_midway',
      progress:.36,
      etaOffsetMin:3.0,
      sharedStartFraction:0,
      sharedEndFraction:.78,
      mode:'leave',
      latOffset:.008,
      lngOffset:.007,
    },

    {
      id:'user9',
      group:'unrelated',
      progress:.40,
      etaOffsetMin:-1.0,
      sharedStartFraction:null,
      sharedEndFraction:null,
      mode:'unrelated',
      latOffset:.014,
      lngOffset:.012,
    },
    {
      id:'user10',
      group:'unrelated',
      progress:.31,
      etaOffsetMin:1.0,
      sharedStartFraction:null,
      sharedEndFraction:null,
      mode:'unrelated',
      latOffset:-.013,
      lngOffset:.014,
    },
  ];

  for (
    const definition
    of definitions
  ) {
    const candidate =
      makeCandidate(
        definition
      );

    const cum =
      cumulativeDistances(
        candidate.route
      );

    states.set(
      candidate.id,
      {
        candidate,
        cum,
      }
    );
  }
}

function clearSimulationVisuals() {
  if (aMarker) {
    aMarker.setMap(null);
  }

  if (originMarker) {
    originMarker.setMap(null);
  }

  if (destinationMarker) {
    destinationMarker.setMap(null);
  }

  aMarker = null;
  originMarker = null;
  destinationMarker = null;

  cpMarkers.forEach(
    marker =>
      marker.setMap(null)
  );

  cpMarkers = [];

  candidateMarkers.forEach(
    marker =>
      marker.setMap(null)
  );

  candidateMarkers.clear();

  candidateLines.forEach(
    line =>
      line.setMap(null)
  );

  candidateLines.clear();

  commonCpHighlights.forEach(
    marker =>
      marker.setMap(null)
  );

  commonCpHighlights.clear();
}

async function generateExperiment() {
  stop();
  clearSimulationVisuals();

  directionsRenderer.set(
    'directions',
    null
  );

  setStatus(
    'Google Mapsで経路を取得しています…'
  );

  try {
    const result =
      await requestGoogleRoute();

    directionsRenderer
      .setDirections(
        result
      );

    const googleRoute =
      result.routes[0];

    const leg =
      googleRoute.legs[0];

    route =
      sampleRoute(
        googleRoute.overview_path,
        40
      );

    baseCum =
      cumulativeDistances(
        route
      );

    const actualDistanceMeters =
      Number(
        leg.distance?.value
      )
      ||
      baseCum[
        baseCum.length - 1
      ];

    routeDurationSeconds =
      Number(
        leg.duration?.value
      )
      || 1;

    const cpResult =
      buildDistanceBasedCheckpoints(
        route,
        baseCum
      );

    // 走行距離に応じて生成された中間チェックポイント
    const intermediateCheckpoints =
      cpResult.checkpoints;

    // 最後の中間チェックポイント通過後もマッチングを継続するため，
    // 目的地を終端評価地点 GOAL として追加する．
    const goalCheckpoint = {
      id: 'GOAL',
      name: '目的地',
      fraction: 1.0,
      routeIndex: route.length - 1,
      location: route[route.length - 1],
      isDestination: true,
    };

    checkpoints = [
      ...intermediateCheckpoints,
      goalCheckpoint,
    ];

    divisions =
      cpResult.divisions;

    const initialAIndex =
      indexAtFraction(
        baseCum,
        CAR_A_INITIAL_PROGRESS
      );

    const remainingDistanceRatio =
      (
        baseCum[
          baseCum.length - 1
        ]
        -
        baseCum[
          initialAIndex
        ]
      )
      /
      baseCum[
        baseCum.length - 1
      ];

    userA = {
      initialIndex:
        initialAIndex,

      initialRemainingEtaSeconds:
        Math.max(
          60,
          routeDurationSeconds
          * remainingDistanceRatio
        ),
    };

    elapsed = 0;

    buildCandidates();

    drawExperimentMap(
      leg
    );

    renderCheckpoints();

    update();

    el.origin.textContent =
      leg.start_address
      ||
      el.originInput.value.trim();

    el.destination.textContent =
      leg.end_address
      ||
      el.destinationInput.value.trim();

    el.routeDistance.textContent =
      `${
        (
          actualDistanceMeters
          / 1000
        ).toFixed(2)
      } km`;

    el.divisionCount.textContent =
      `${divisions}分割`;

    const intermediateCheckpointCount =
      checkpoints.filter(
        cp => !cp.isDestination
      ).length;

    el.checkpointCount.textContent =
      `${intermediateCheckpointCount}地点`;

    el.start.disabled = false;
    el.pause.disabled = true;
    el.reset.disabled = false;

    setStatus(
      `経路生成完了．`
      + `${(actualDistanceMeters / 1000).toFixed(2)} km`
      + ` → ${divisions}分割`
      + ` → 中間チェックポイント ${checkpoints.length}地点．`
    );

  } catch (error) {
    console.error(error);

    setStatus(
      `経路生成失敗: ${error.message}`,
      true
    );
  }
}

function drawExperimentMap(
  leg
) {
  originMarker =
    new google.maps.Marker({
      position:
        latLngObject(
          leg.start_location
        ),

      map,

      title:
        '出発地',

      label: {
        text:'S',
        color:'#fff',
      },

      icon:
        markerIcon(
          '#2563eb',
          9
        ),

      zIndex:
        100,
    });

  destinationMarker =
    new google.maps.Marker({
      position:
        latLngObject(
          leg.end_location
        ),

      map,

      title:
        '目的地',

      label: {
        text:'G',
        color:'#fff',
      },

      icon:
        markerIcon(
          '#dc2626',
          9
        ),

      zIndex:
        100,
    });

  cpMarkers =
    checkpoints
      .filter(cp => !cp.isDestination)
      .map(
      cp =>
        new google.maps.Marker({
          position:
            cp.location,

          map,

          title:
            `${cp.id}：`
            + `走行距離 `
            + `${(cp.fraction * 100).toFixed(1)}%地点`,

          label: {
            text:
              cp.id,

            color:
              '#fff',

            fontSize:
              '10px',
          },

          icon:
            markerIcon(
              '#7c3aed',
              7
            ),

          zIndex:
            70,
        })
    );

  for (
    const state
    of states.values()
  ) {
    const candidate =
      state.candidate;
candidateLines.set(
      candidate.id,

      new google.maps.Polyline({
        path:
          candidate.route,

        map,

        strokeColor: '#64748b',
        strokeOpacity: 0.20,

        strokeWeight:
          3,

        zIndex:
          10,
      })
    );
  }
}

function currentAIndex() {
  if (!userA) {
    return 0;
  }

  const fraction =
    Math.min(
      1,
      elapsed
      /
      Math.max(
        1,
        userA.initialRemainingEtaSeconds
      )
    );

  return Math.min(
    route.length - 1,

    Math.round(
      userA.initialIndex
      +
      fraction
      * (
        route.length - 1
        - userA.initialIndex
      )
    )
  );
}

function currentCandidateIndex(
  candidate
) {
  const fraction =
    Math.min(
      1,
      elapsed
      /
      Math.max(
        1,
        candidate.initialRemainingEtaSeconds
      )
    );

  return Math.min(
    candidate.route.length - 1,

    Math.round(
      candidate.initialIndex
      +
      fraction
      * (
        candidate.route.length - 1
        - candidate.initialIndex
      )
    )
  );
}

function updateMarkers(
  ai
) {
  const pointA =
    route[ai];

  if (!aMarker) {
    aMarker =
      new google.maps.Marker({
        position:
          pointA,

        map,

        title:
          'Car A',

        label: {
          text:'A',
          color:'#fff',
          fontSize:'10px',
        },

        icon:
          markerIcon(
            '#00a8ff',
            10
          ),

        zIndex:
          120,
      });
  } else {
    aMarker.setPosition(
      pointA
    );
  }

  for (
    const state
    of states.values()
  ) {
    const c =
      state.candidate;

    c.currentIndex =
      currentCandidateIndex(
        c
      );

    const point =
      c.route[
        c.currentIndex
      ];

    let marker =
      candidateMarkers.get(
        c.id
      );

    if (!marker) {
      marker =
        new google.maps.Marker({
          position:
            point,

          map,

          title:
            `${c.id} / ${typeNames[c.group]}`,

          label: {
            text:
              c.id.replace(
                'user',
                ''
              ),

            color:
              '#fff',

            fontSize:
              '9px',
          },

          icon:
            markerIcon('#64748b', 7),

          zIndex:
            90,
        });

      marker.addListener(
        'click',
        () =>
          renderDetail(
            c.id
          )
      );

      candidateMarkers.set(
        c.id,
        marker
      );

    } else {
      marker.setPosition(
        point
      );
    }
  }
}

function evaluateAll(
  ai
) {
  const results = [];

  for (
    const state
    of states.values()
  ) {
    const c =
      state.candidate;

    results.push({
      id:
        c.id,

      candidate:
        c,

      result:
        evaluate({
          userA,
          candidate:
            c,

          checkpoints,

          currentAIndex:
            ai,

          currentBIndex:
            c.currentIndex,

          elapsedSeconds:
            elapsed,

          baseCum,

          candidateCum:
            state.cum,
        }),
    });
  }

  return results.sort(
    (a, b) => {
      // MATCH判定を優先し，同じ判定内ではScoreの高い順に並べる．
      if (a.result.eligible !== b.result.eligible) {
        return a.result.eligible ? -1 : 1;
      }

      return b.result.score - a.result.score;
    }
  );
}

function highlightCommonCheckpoints(
  results
) {
  commonCpHighlights.forEach(
    marker =>
      marker.setMap(null)
  );

  commonCpHighlights.clear();

  for (
    const item
    of results
  ) {
    const cp =
      item.result.cp;

    if (
      !cp
      ||
      commonCpHighlights.has(
        cp.id
      )
    ) {
      continue;
    }

    const marker =
      new google.maps.Marker({
        position:
          cp.location,

        map,

        title:
          `現在の評価対象共通チェックポイント：${cp.id}`,

        icon: {
          path:
            google.maps.SymbolPath.CIRCLE,

          scale:
            13,

          fillColor:
            '#f59e0b',

          fillOpacity:
            0.12,

          strokeColor:
            '#f59e0b',

          strokeWeight:
            3,
        },

        zIndex:
          75,
      });

    commonCpHighlights.set(
      cp.id,
      marker
    );
  }
}

function renderCheckpoints() {
  el.checkpointList.innerHTML =
    checkpoints
      .map(
        cp => `
          <div class="checkpoint-item ${cp.isDestination ? 'goal-item' : ''}">
            <strong>
              ${escapeHtml(cp.isDestination ? 'GOAL（目的地）' : cp.id)}
            </strong>

            <span>
              ${
                cp.isDestination
                  ? '最終評価地点'
                  : `${(cp.fraction * 100).toFixed(1)}%地点`
              }
            </span>

            <small>
              ${cp.location.lat.toFixed(6)},
              ${cp.location.lng.toFixed(6)}
            </small>
          </div>
        `
      )
      .join('');
}

function renderList(
  results
) {
  el.candidateList.innerHTML =
    results
      .map(
        item => {
          const r =
            item.result;
return `
            <button
              class="candidate-card ${r.eligible ? 'matched' : ''}"
              data-id="${item.id}"
              type="button"
            >
              <div class="head">
                <strong>${item.id}</strong>

                <span class="type">
                  ${typeNames[item.candidate.group]}
                </span>
              </div>

              <div class="main">
                <span>
                  ${r.eligible ? 'MATCH' : 'NO MATCH'}
                </span>

                <strong>
                  Score ${f3(r.score)}
                </strong>
              </div>

              <div class="cp">
                共通チェックポイント:
                ${r.cp ? (r.cp.isDestination ? 'GOAL（目的地）' : r.cp.id) : 'なし'}
                <br>
                先行条件:
                ${
                  r.leadDeltaMinutes == null
                    ? '—'
                    : r.candidateIsAhead
                      ? `○ Bが${Math.abs(r.leadDeltaMinutes).toFixed(2)}分先行`
                      : `× Bが${Math.abs(r.leadDeltaMinutes).toFixed(2)}分後続`
                }
              </div>

              <div class="mini">
                <span>
                  Route
                  <br>
                  <b>${f3(r.simRoute)}</b>
                </span>

                <span>
                  Time
                  <br>
                  <b>${f3(r.simTime)}</b>
                </span>

                <span>
                  Spatial
                  <br>
                  <b>${f3(r.simSpatial)}</b>
                </span>
              </div>
            </button>
          `;
        }
      )
      .join('');

  el.candidateList
    .querySelectorAll(
      '[data-id]'
    )
    .forEach(
      button => {
        button.addEventListener(
          'click',
          () => {
            const id =
              button.dataset.id;

            renderDetail(
              id,
              results
            );

            const state =
              states.get(id);

            if (state) {
              map.panTo(
                state.candidate.route[
                  state.candidate.currentIndex
                ]
              );
            }
          }
        );
      }
    );
}

function renderDetail(
  id,
  cached = null
) {
  if (!userA) {
    return;
  }

  const results =
    cached
    ||
    evaluateAll(
      currentAIndex()
    );

  const item =
    results.find(
      x =>
        x.id === id
    );

  if (!item) {
    return;
  }

  const r =
    item.result;

  el.vehicleDetail.innerHTML = `
    <div class="detail-title">
      ${item.id}

      <span>
        ${typeNames[item.candidate.group]}
      </span>
    </div>

    <div class="detail-grid">
      <div>
        <small>共通チェックポイント</small>
        <b>${r.cp ? (r.cp.isDestination ? 'GOAL（目的地）' : r.cp.id) : 'なし'}</b>
      </div>

      <div>
        <small>ETA A→チェックポイント</small>
        <b>${fm(r.etaA)}</b>
      </div>

      <div>
        <small>ETA B→チェックポイント</small>
        <b>${fm(r.etaB)}</b>
      </div>

      <div>
        <small>ΔETA（絶対値）</small>
        <b>${fm(r.deltaEta)}</b>
      </div>

      <div>
        <small>先行判定 ΔETA(A-B)</small>
        <b>
          ${
            r.leadDeltaMinutes == null
              ? '—'
              : `${r.leadDeltaMinutes.toFixed(2)} 分`
          }
        </b>
      </div>

      <div>
        <small>BはAより先か</small>
        <b>
          ${
            r.leadDeltaMinutes == null
              ? '—'
              : r.candidateIsAhead
                ? '○ 先行'
                : '× 後続'
          }
        </b>
      </div>

      <div>
        <small>A→チェックポイント距離</small>
        <b>${fk(r.distanceKm)}</b>
      </div>

      <div>
        <small>Route</small>
        <b>${f3(r.simRoute)}</b>
      </div>

      <div>
        <small>Time</small>
        <b>${f3(r.simTime)}</b>
      </div>

      <div>
        <small>Spatial</small>
        <b>${f3(r.simSpatial)}</b>
      </div>

      <div>
        <small>Score</small>
        <b>${f3(r.score)}</b>
      </div>

      <div>
        <small>評価モード</small>
        <b>${
          r.evaluationMode === 'GOAL_MODE'
            ? 'GOALモード'
            : r.evaluationMode === 'NORMAL_MODE'
              ? '通常モード'
              : '—'
        }</b>
      </div>

      <div class="wide-detail">
        <small>使用重み</small>
        <b>${
          r.weights
            ? `Route ${r.weights.route.toFixed(2)} / Time ${r.weights.time.toFixed(2)} / Spatial ${r.weights.spatial.toFixed(2)}`
            : '—'
        }</b>
      </div>

      <div>
        <small>判定</small>
        <b>
          ${
            r.eligible
              ? 'MATCH'
              : 'NO MATCH'
          }
        </b>
      </div>
    </div>
  `;
}

function updateStats(
  ai,
  results
) {
  const point =
    route[ai];

  const progress =
    baseCum[ai]
    /
    baseCum[
      baseCum.length - 1
    ];

  const matches =
    results.filter(
      x =>
        x.result.eligible
    );

  el.simTime.textContent =
    `${(elapsed / 60).toFixed(2)} 分`;

  el.aProgress.textContent =
    `${(progress * 100).toFixed(1)} %`;

  el.aPosition.textContent =
    `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;

  el.matchCount.textContent =
    `${matches.length} / ${results.length}`;

  el.bestScore.textContent =
    matches.length
      ? matches[0].result.score.toFixed(3)
      : '—';
}

function update() {
  if (!userA) {
    return;
  }

  const ai =
    currentAIndex();

  updateMarkers(ai);

  const results =
    evaluateAll(ai);

  highlightCommonCheckpoints(
    results
  );

  renderList(
    results
  );

  updateStats(
    ai,
    results
  );

  if (
    results.length
  ) {
    renderDetail(
      results[0].id,
      results
    );
  }

  if (
    ai
    >=
    route.length - 1
  ) {
    stop();

    setStatus(
      'Car A が目的地へ到着しました．'
    );
  }
}

function start() {
  if (
    !userA
    ||
    timer
  ) {
    return;
  }

  timer =
    setInterval(
      () => {
        elapsed +=
          BASE_STEP_SEC
          *
          (
            Number(
              el.speed.value
            )
            || 1
          );

        update();
      },

      STEP_MS
    );

  el.start.disabled = true;
  el.pause.disabled = false;

  setStatus(
    'シミュレーション実行中'
  );
}

function stop() {
  clearInterval(timer);

  timer = null;

  if (userA) {
    el.start.disabled = false;
  }

  el.pause.disabled = true;
}

function reset() {
  stop();

  elapsed = 0;

  update();

  setStatus(
    '35%地点の初期状態へ戻しました．'
  );
}

function renderParameters() {
  el.parameterInfo.innerHTML = `
    <div><b>通常時</b> = 0.50 Route + 0.30 Time + 0.20 Spatial</div>
    <div><b>最終チェックポイント通過後（GOAL）</b> = 0.60 Time + 0.40 Spatial（Routeは評価対象外）</div>
    <div><b>閾値</b> = ${CONFIG.threshold}</div>
    <div>
      <b>MATCH必須条件</b>：
      ETA_A − ETA_B &gt; 0
      （候補車Bが共通チェックポイントへ先に到達）
    </div>
  `;
}


function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', value);
  localStorage.setItem('driveria-theme', value);

  if (el.themeToggle) {
    const light = value === 'light';
    el.themeToggle.textContent = light ? '☾' : '☀';
    el.themeToggle.title = light ? 'ダークモードへ切替' : 'ライトモードへ切替';
    el.themeToggle.setAttribute('aria-label', el.themeToggle.title);
  }
}

function toggleTheme() {
  const current =
    document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function initializeTheme() {
  const saved = localStorage.getItem('driveria-theme');
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved);
    return;
  }

  const light =
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: light)').matches;

  applyTheme(light ? 'light' : 'dark');
}

function setPanelCollapsed(collapsed) {
  const value = Boolean(collapsed);

  document.body.classList.toggle(
    'panel-collapsed',
    value
  );

  localStorage.setItem(
    'driveria-panel-collapsed',
    value ? '1' : '0'
  );

  if (el.panelOpen) {
    el.panelOpen.classList.toggle(
      'visible',
      value
    );
  }

  // パネル開閉後にGoogle Mapsへコンテナサイズ変更を通知する
  if (typeof google !== 'undefined' && map) {
    window.setTimeout(() => {
      google.maps.event.trigger(map, 'resize');

      if (route.length) {
        const ai = currentAIndex();
        if (route[ai]) {
          map.setCenter(route[ai]);
        }
      }
    }, 80);

    window.setTimeout(() => {
      google.maps.event.trigger(map, 'resize');
    }, 320);
  }
}

function initializePanelState() {
  setPanelCollapsed(
    localStorage.getItem('driveria-panel-collapsed') === '1'
  );
}

async function main() {
  initializeTheme();
  initializePanelState();

  renderParameters();

  el.themeToggle?.addEventListener('click', toggleTheme);
  el.panelClose?.addEventListener('click', () => setPanelCollapsed(true));
  el.panelOpen?.addEventListener('click', () => setPanelCollapsed(false));

  el.generate.addEventListener(
    'click',
    generateExperiment
  );

  el.start.addEventListener(
    'click',
    start
  );

  el.pause.addEventListener(
    'click',
    stop
  );

  el.reset.addEventListener(
    'click',
    reset
  );

  try {
    setStatus(
      'Google Mapsを読み込んでいます…'
    );

    await loadGoogleMaps();

    initMap();

    setStatus(
      '準備完了．出発地と目的地を入力して経路を生成してください．'
    );

  } catch (error) {
    console.error(error);

    setStatus(
      error.message,
      true
    );
  }
}

authElements.form?.addEventListener('submit', handleAuthSubmit);
