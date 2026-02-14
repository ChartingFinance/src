/**
 * asset-queries.js
 *
 * Collection-level queries over ModelAsset arrays.
 * Replaces: util_firstDateInt, util_lastDateInt, util_findModelAssetByDisplayName,
 *           util_removeModelAssetByDisplayName, util_findModelAssetsByInstrument
 */

import { DateInt } from './date-int.js';

/**
 * Find the earliest start date across all assets.
 * @param {ModelAsset[]} assets
 * @returns {DateInt|null}
 */
export function firstDateInt(assets) {
  if (!assets?.length) return null;
  return assets.reduce((earliest, a) =>
    !earliest || a.startDateInt.isBefore(earliest) ? a.startDateInt : earliest,
    null
  );
}

/**
 * Find the latest finish date across all assets.
 * @param {ModelAsset[]} assets
 * @returns {DateInt|null}
 */
export function lastDateInt(assets) {
  if (!assets?.length) return null;
  return assets.reduce((latest, a) =>
    !latest || a.finishDateInt.isAfter(latest) ? a.finishDateInt : latest,
    null
  );
}

/**
 * Find an asset by its display name.
 * @param {ModelAsset[]} assets
 * @param {string} displayName
 * @returns {ModelAsset|undefined}
 */
export function findByName(assets, displayName) {
  return assets.find(a => a.displayName === displayName);
}

/**
 * Remove an asset by display name (mutates the array).
 * @param {ModelAsset[]} assets
 * @param {string} displayName
 * @returns {ModelAsset|undefined} The removed asset, or undefined
 */
export function removeByName(assets, displayName) {
  const idx = assets.findIndex(a => a.displayName === displayName);
  return idx >= 0 ? assets.splice(idx, 1)[0] : undefined;
}

/**
 * Filter assets by instrument type.
 * @param {ModelAsset[]} assets
 * @param {string|null} instrument  Pass null to return all
 * @returns {ModelAsset[]}
 */
export function filterByInstrument(assets, instrument) {
  if (instrument === null) return [...assets];
  return assets.filter(a => a.instrument === instrument);
}

/**
 * Sort assets by their instrument sort order.
 * @param {ModelAsset[]} assets
 * @returns {ModelAsset[]} New sorted array (does not mutate input)
 */
export function sortByInstrument(assets) {
  return [...assets].sort((a, b) => a.sortIndex() - b.sortIndex());
}
