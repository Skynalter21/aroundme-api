const { S2 } = require("s2-geometry");

/**
 * Retorna a chave da célula S2 para uma coordenada em determinado nível (padrão: 13, ~1.2 km).
 */
function getS2CellKey(lat, lng, level = 13) {
  return S2.latLngToKey(lat, lng, level);
}

/**
 * Retorna as células S2 (célula central + vizinhos) que cobrem um determinado raio em km.
 * Nível 13: ~1.2 km (raio até 2km)
 * Nível 12: ~2.5 km (raio até 6km)
 * Nível 11: ~5.0 km (raio até 15km)
 * Nível 10: ~10 km (raio até 30km)
 * Nível 9:  ~20 km (raio até 60km)
 */
function getCoverageCells(lat, lng, radiusKm = 5) {
  let level = 13;

  if (radiusKm > 30) {
    level = 9;
  } else if (radiusKm > 15) {
    level = 10;
  } else if (radiusKm > 6) {
    level = 11;
  } else if (radiusKm > 2) {
    level = 12;
  } else {
    level = 13;
  }

  const centerKey = S2.latLngToKey(lat, lng, level);
  const direct = S2.latLngToNeighborKeys(lat, lng, level);
  const cellSet = new Set([centerKey, ...direct]);

  // Expande para os vizinhos dos vizinhos (cobre diagonais da grade 3x3)
  for (const k of direct) {
    try {
      const coords = S2.keyToLatLng(k);
      const secondRing = S2.latLngToNeighborKeys(coords.lat, coords.lng, level);
      for (const sk of secondRing) {
        cellSet.add(sk);
      }
    } catch (e) {
      // Ignora erro em bordas de cubo
    }
  }

  return {
    level,
    centerKey,
    cells: Array.from(cellSet),
  };
}

/**
 * Fórmula de Haversine para cálculo exato da distância em Km entre 2 pontos
 */
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

module.exports = {
  getS2CellKey,
  getCoverageCells,
  calculateDistanceKm,
};
