/**
 * Turning GPS coordinates into a track map.
 *
 * The VectorNav reports position as latitude/longitude in degrees. Degrees are
 * useless for drawing: a degree of longitude is a different number of metres at
 * every latitude, so plotting lon/lat directly would squash the track sideways.
 *
 * An FSAE course is a few hundred metres across, which is small enough that we
 * can treat the Earth as flat over that patch and use an equirectangular
 * projection about a fixed origin. Over 500 m the error is millimetres — far
 * below GPS noise — and it costs two multiplications instead of a full
 * geodesic. The origin is the first fix seen, so the map is always in metres
 * from wherever the car happened to be when the widget connected.
 */

import { TRACK_CELL_SIZE_M } from '../config.js'

// Metres per degree of latitude. Very nearly constant; the variation with
// latitude is ~0.5% pole-to-equator, irrelevant at this scale.
const METRES_PER_DEG_LAT = 111132.0
// Metres per degree of longitude AT THE EQUATOR. Shrinks as cos(latitude) —
// this is the factor that makes a naive lon/lat plot wrong.
const METRES_PER_DEG_LON_EQUATOR = 111320.0

/**
 * Build a projector fixed at an origin fix.
 * Returns { toLocal } mapping (lat, lon) -> { x: metres east, y: metres north }.
 */
export function createProjection(originLat, originLon) {
  const metresPerDegLon = METRES_PER_DEG_LON_EQUATOR * Math.cos((originLat * Math.PI) / 180)
  return {
    originLat,
    originLon,
    toLocal(latitude, longitude) {
      return {
        x: (longitude - originLon) * metresPerDegLon,
        y: (latitude - originLat) * METRES_PER_DEG_LAT,
      }
    },
  }
}

/** True when a fix looks real. (0,0) is the classic "no lock yet" sentinel. */
export function isValidFix(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) > 0.0001 &&
    Math.abs(longitude) > 0.0001 &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  )
}

/** Grid cell key for a local position. Cells are TRACK_CELL_SIZE_M square. */
export function cellKey(x, y) {
  return `${Math.round(x / TRACK_CELL_SIZE_M)},${Math.round(y / TRACK_CELL_SIZE_M)}`
}

/** Centre of the cell a key refers to, back in metres. */
export function cellCentre(key) {
  const [ix, iy] = key.split(',').map(Number)
  return { x: ix * TRACK_CELL_SIZE_M, y: iy * TRACK_CELL_SIZE_M }
}

/**
 * Fit a set of points into a viewBox, preserving aspect ratio.
 *
 * Preserving it is not cosmetic: an FSAE course here is 150 m wide by 458 m
 * long, and stretching that to fill a wide panel would change every corner's
 * apparent radius — a hairpin would look like a sweeper.
 */
export function fitBounds(points, viewWidth, viewHeight, padding = 18) {
  if (!points.length) return null

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const { x, y } of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  const spanX = Math.max(maxX - minX, 1)
  const spanY = Math.max(maxY - minY, 1)
  const usableWidth = viewWidth - padding * 2
  const usableHeight = viewHeight - padding * 2
  const scale = Math.min(usableWidth / spanX, usableHeight / spanY)

  // Centre whatever slack the aspect ratio leaves over.
  const offsetX = padding + (usableWidth - spanX * scale) / 2
  const offsetY = padding + (usableHeight - spanY * scale) / 2

  return {
    scale,
    project(x, y) {
      return {
        // SVG y grows downward, north grows upward — hence the flip, without
        // which the whole track would be drawn mirrored.
        px: offsetX + (x - minX) * scale,
        py: viewHeight - (offsetY + (y - minY) * scale),
      }
    },
  }
}
