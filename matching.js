/**
 * Driveria common-checkpoint based matching model
 *
 * Time unit    : minute
 * Spatial unit : km
 */

export const CONFIG = Object.freeze({
  kTime: 0.07,
  kSpatial: 0.07,
  threshold: 0.50,

  normalWeights: Object.freeze({
    route: 0.50,
    time: 0.30,
    spatial: 0.20,
  }),

  goalWeights: Object.freeze({
    route: 0.00,
    time: 0.60,
    spatial: 0.40,
  }),
});

const EARTH_RADIUS_M = 6371000;
const toRad = deg => deg * Math.PI / 180;

export function distanceMeters(a, b) {
  const lat1 = toRad(Number(a.lat));
  const lat2 = toRad(Number(b.lat));
  const dLat = lat2 - lat1;
  const dLng = toRad(Number(b.lng) - Number(a.lng));

  const h =
    Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_M * 2
    * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function cumulativeDistances(route) {
  const out = [0];

  for (let i = 1; i < route.length; i += 1) {
    out.push(
      out[i - 1]
      + distanceMeters(route[i - 1], route[i])
    );
  }

  return out;
}

export function routeDistance(cumulative, startIndex, endIndex) {
  const start = Math.max(
    0,
    Math.min(cumulative.length - 1, Number(startIndex))
  );

  const end = Math.max(
    0,
    Math.min(cumulative.length - 1, Number(endIndex))
  );

  if (end <= start) return 0;

  return cumulative[end] - cumulative[start];
}

export function indexAtFraction(cumulative, fraction) {
  const total = cumulative[cumulative.length - 1];
  const target = total * Math.max(0, Math.min(1, fraction));

  let bestIndex = 0;
  let bestDiff = Infinity;

  cumulative.forEach((value, index) => {
    const diff = Math.abs(value - target);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function checkpointDivisionCount(distanceKm) {
  // Driveria 中間チェックポイント生成基準
  // 10 km未満    : 3分割 → 中間チェックポイント 2地点
  // 10〜30 km    : 4分割 → 中間チェックポイント 3地点
  // 30〜100 km   : 5分割 → 中間チェックポイント 4地点
  // 100 km超     : 6分割 → 中間チェックポイント 5地点
  if (distanceKm < 10) return 3;
  if (distanceKm < 30) return 4;
  if (distanceKm <= 100) return 5;
  return 6;
}

export function buildDistanceBasedCheckpoints(route, cumulative) {
  const totalKm =
    cumulative[cumulative.length - 1] / 1000;

  const divisions =
    checkpointDivisionCount(totalKm);

  const checkpoints = [];

  for (let i = 1; i < divisions; i += 1) {
    const fraction = i / divisions;
    const routeIndex =
      indexAtFraction(cumulative, fraction);

    checkpoints.push({
      id: `チェックポイント${i}`,
      name: `チェックポイント${i}`,
      fraction,
      routeIndex,
      location: route[routeIndex],
    });
  }

  return {
    checkpoints,
    divisions,
  };
}

export function computeSimTime(deltaEtaMinutes) {
  if (!Number.isFinite(deltaEtaMinutes)) return 0;

  return Math.exp(
    -CONFIG.kTime
    * Math.abs(deltaEtaMinutes)
  );
}

export function computeSimSpatial(distanceKm) {
  if (!Number.isFinite(distanceKm)) return 0;

  return Math.exp(
    -CONFIG.kSpatial
    * Math.max(0, distanceKm)
  );
}

export function computeScore(
  simRoute,
  simTime,
  simSpatial,
  weights = CONFIG.normalWeights
) {
  return (
    weights.route * simRoute
    + weights.time * simTime
    + weights.spatial * simSpatial
  );
}

function etaToIndexMinutes({
  cumulative,
  currentIndex,
  targetIndex,
  remainingEtaSeconds,
}) {
  if (targetIndex < currentIndex) {
    return null;
  }

  if (targetIndex === currentIndex) {
    return 0;
  }

  const remainingDistance =
    routeDistance(
      cumulative,
      currentIndex,
      cumulative.length - 1
    );

  const distanceToTarget =
    routeDistance(
      cumulative,
      currentIndex,
      targetIndex
    );

  if (remainingDistance <= 0) {
    return targetIndex === currentIndex ? 0 : null;
  }

  return (
    Math.max(0, remainingEtaSeconds)
    * (distanceToTarget / remainingDistance)
    / 60
  );
}

function isCheckpointShared(candidate, checkpointIndex) {
  const range = candidate.sharedRange;

  if (!range) return false;

  return (
    checkpointIndex >= range.startIndex
    && checkpointIndex <= range.endIndex
  );
}

function firstFutureCommonCheckpoint({
  checkpoints,
  candidate,
  currentAIndex,
  currentBIndex,
}) {
  const future = (checkpoints || [])
    .filter(cp => {
      const cpIndex =
        Number(cp.routeIndex);

      if (!isCheckpointShared(candidate, cpIndex)) {
        return false;
      }

      // GOALは特別扱い．
      // Car Aがまだ目的地に着いていない間は，
      // 候補車BがGOAL手前でも，既にGOAL到着済みでも
      // 最終共通地点として評価対象にできる．
      if (cp.isDestination) {
        return (
          cpIndex > Number(currentAIndex)
          &&
          Number(currentBIndex) <= cpIndex
        );
      }

      // 通常の中間チェックポイントは両車が未通過であることが条件．
      return (
        cpIndex > Number(currentAIndex)
        &&
        cpIndex > Number(currentBIndex)
      );
    })
    .sort(
      (a, b) =>
        a.routeIndex - b.routeIndex
    );

  return future[0] || null;
}

function simRouteAfterCheckpoint({
  baseCumulative,
  checkpointIndex,
  sharedRange,
}) {
  if (!sharedRange) return 0;

  const baseEndIndex =
    baseCumulative.length - 1;

  const aRemaining =
    routeDistance(
      baseCumulative,
      checkpointIndex,
      baseEndIndex
    );

  if (aRemaining <= 0) return 0;

  const overlapStart =
    Math.max(
      checkpointIndex,
      sharedRange.startIndex
    );

  const overlapEnd =
    Math.min(
      baseEndIndex,
      sharedRange.endIndex
    );

  if (overlapEnd <= overlapStart) return 0;

  const sharedDistance =
    routeDistance(
      baseCumulative,
      overlapStart,
      overlapEnd
    );

  return Math.max(
    0,
    Math.min(
      1,
      sharedDistance / aRemaining
    )
  );
}

export function evaluate({
  userA,
  candidate,
  checkpoints,
  currentAIndex,
  currentBIndex,
  elapsedSeconds,
  baseCum,
  candidateCum,
}) {
  const cp =
    firstFutureCommonCheckpoint({
      checkpoints,
      candidate,
      currentAIndex,
      currentBIndex,
    });

  if (!cp) {
    return {
      eligible: false,
      reason: 'NO_FUTURE_COMMON_CHECKPOINT',
      evaluationMode: 'NONE',
      weights: null,
      score: 0,
      simRoute: 0,
      simTime: 0,
      simSpatial: 0,
      cp: null,
      etaA: null,
      etaB: null,
      deltaEta: null,
      leadDeltaMinutes: null,
      candidateIsAhead: false,
      distanceKm: null,
    };
  }

  const remainingA =
    Math.max(
      0,
      userA.initialRemainingEtaSeconds
      - elapsedSeconds
    );

  const remainingB =
    Math.max(
      0,
      candidate.initialRemainingEtaSeconds
      - elapsedSeconds
    );

  const etaA =
    etaToIndexMinutes({
      cumulative: baseCum,
      currentIndex: currentAIndex,
      targetIndex: cp.routeIndex,
      remainingEtaSeconds: remainingA,
    });

  const etaB =
    etaToIndexMinutes({
      cumulative: candidateCum,
      currentIndex: currentBIndex,
      targetIndex: cp.routeIndex,
      remainingEtaSeconds: remainingB,
    });

  if (
    !Number.isFinite(etaA)
    || !Number.isFinite(etaB)
  ) {
    return {
      eligible: false,
      reason: 'ETA_UNAVAILABLE',
      evaluationMode: cp?.isDestination ? 'GOAL_MODE' : 'NORMAL_MODE',
      weights: cp?.isDestination ? CONFIG.goalWeights : CONFIG.normalWeights,
      score: 0,
      simRoute: 0,
      simTime: 0,
      simSpatial: 0,
      cp,
      etaA,
      etaB,
      deltaEta: null,
      leadDeltaMinutes: null,
      candidateIsAhead: false,
      distanceKm: null,
    };
  }

  // 符号付き時間差
  //
  // leadDeltaMinutes = ETA_A - ETA_B
  //
  // > 0 : 候補車Bが自車Aより先に共通チェックポイントへ到達
  // = 0 : 同時到達
  // < 0 : 候補車Bが自車Aより後に共通チェックポイントへ到達
  const leadDeltaMinutes =
    etaA - etaB;

  // SimTime自体は到達時刻の「差の大きさ」を評価するため絶対値を使用
  const deltaEta =
    Math.abs(leadDeltaMinutes);

  const candidateIsAhead =
    leadDeltaMinutes > 0;

  const distanceKm =
    routeDistance(
      baseCum,
      currentAIndex,
      cp.routeIndex
    ) / 1000;

  const isGoalMode =
    Boolean(cp.isDestination);

  const simRoute =
    isGoalMode
      ? 0
      : simRouteAfterCheckpoint({
          baseCumulative: baseCum,
          checkpointIndex: cp.routeIndex,
          sharedRange: candidate.sharedRange,
        });

  const simTime =
    computeSimTime(deltaEta);

  const simSpatial =
    computeSimSpatial(distanceKm);

  const weights =
    isGoalMode
      ? CONFIG.goalWeights
      : CONFIG.normalWeights;

  const score =
    computeScore(
      simRoute,
      simTime,
      simSpatial,
      weights
    );

  // Driveriaの情報取得方向をA→Bに固定する．
  // BがAより先に共通チェックポイントへ到達し，かつScoreが閾値以上の場合のみMATCH．
  const eligible =
    candidateIsAhead
    &&
    score >= CONFIG.threshold;

  let reason;

  if (!candidateIsAhead) {
    reason = 'CANDIDATE_NOT_AHEAD';
  } else if (score < CONFIG.threshold) {
    reason = 'BELOW_THRESHOLD';
  } else {
    reason = 'MATCH';
  }

  return {
    eligible,
    reason,

    candidateIsAhead,
    leadDeltaMinutes,

    evaluationMode:
      isGoalMode
        ? 'GOAL_MODE'
        : 'NORMAL_MODE',

    weights,
    score,
    simRoute,
    simTime,
    simSpatial,
    cp,
    etaA,
    etaB,
    deltaEta,
    distanceKm,
  };
}
