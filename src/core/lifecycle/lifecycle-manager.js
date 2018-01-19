// Copyright (c) 2015 - 2017 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import assert from 'assert';
import seer from 'seer';
import Layer from './layer';
import {LIFECYCLE} from './constants';
import log from '../utils/log';
import {flatten} from '../utils/flatten';

import {
  setPropOverrides,
  layerEditListener,
  seerInitListener,
  initLayerInSeer,
  updateLayerInSeer
} from './seer-integration';

const LOG_PRIORITY_LIFECYCLE = 2;
const LOG_PRIORITY_LIFECYCLE_MINOR = 4;

const initialContext = {
  uniforms: {},
  viewports: [],
  viewport: null,
  layerFilter: null,
  viewportChanged: true,
  pickingFBO: null,
  useDevicePixels: true,
  lastPickedInfo: {
    index: -1,
    layerId: null
  }
};

const layerName = layer => (layer instanceof Layer ? `${layer}` : !layer ? 'null' : 'invalid');

export default class LayerManager {
  // eslint-disable-next-line
  constructor() {
    // Currently deck.gl expects the DeckGL.layers array to be different
    // whenever React rerenders. If the same layers array is used, the
    // LayerManager's diffing algorithm will generate a fatal error and
    // break the rendering.

    // `this.lastRenderedLayers` stores the UNFILTERED layers sent
    // down to LayerManager, so that `layers` reference can be compared.
    // If it's the same across two React render calls, the diffing logic
    // will be skipped.
    this.lastRenderedLayers = [];
    this.prevLayers = [];
    this.layers = [];

    this.oldContext = {};
    this.context = Object.assign({}, initialContext);

    this._needsRedraw = 'Initial render';

    // Seer integration
    this._initSeer = this._initSeer.bind(this);
    this._editSeer = this._editSeer.bind(this);
    seerInitListener(this._initSeer);
    layerEditListener(this._editSeer);

    Object.seal(this);
  }

  /**
   * Method to call when the layer manager is not needed anymore.
   *
   * Currently used in the <DeckGL> componentWillUnmount lifecycle to unbind Seer listeners.
   */
  finalize() {
    seer.removeListener(this._initSeer);
    seer.removeListener(this._editSeer);
  }

  needsRedraw({clearRedrawFlags = true} = {}) {
    return this._checkIfNeedsRedraw(clearRedrawFlags);
  }

  // Normally not called by app
  setNeedsRedraw(reason) {
    this._needsRedraw = this._needsRedraw || reason;
  }

  // Gets an (optionally) filtered list of layers
  getLayers({layerIds = null} = {}) {
    // Filtering by layerId compares beginning of strings, so that sublayers will be included
    // Dependes on the convention of adding suffixes to the parent's layer name
    return layerIds
      ? this.layers.filter(layer => layerIds.find(layerId => layer.id.indexOf(layerId) === 0))
      : this.layers;
  }

  /**
   * Set parameters needed for layer rendering and picking.
   * Parameters are to be passed as a single object, with the following values:
   * @param {Boolean} useDevicePixels
   */
  setParameters(parameters) {
    // TODO - For now we set layers before viewports to preservenchangeFlags
    if ('layers' in parameters) {
      this.setLayers(parameters.layers);
    }

    if ('layerFilter' in parameters) {
      this.context.layerFilter = parameters.layerFilter;
      if (this.context.layerFilter !== parameters.layerFilter) {
        this.setNeedsRedraw('layerFilter changed');
      }
    }

    Object.assign(this.context, parameters);
  }

  // Supply a new layer list, initiating sublayer generation and layer matching
  setLayers(newLayers) {
    assert(this.context.viewport, 'LayerManager.updateLayers: viewport not set');

    // TODO - something is generating state updates that cause rerender of the same
    if (newLayers === this.lastRenderedLayers) {
      log.log(3, 'Ignoring layer update due to layer array not changed');
      return this;
    }
    this.lastRenderedLayers = newLayers;

    newLayers = flatten(newLayers, {filter: Boolean});

    for (const layer of newLayers) {
      layer.context = this.context;
    }

    this.prevLayers = this.layers;
    const {error, generatedLayers} = this._updateLayers({
      oldLayers: this.prevLayers,
      newLayers
    });

    this.layers = generatedLayers;
    // Throw first error found, if any
    if (error) {
      throw error;
    }
    return this;
  }

  //
  // PRIVATE METHODS
  //

  _checkIfNeedsRedraw(clearRedrawFlags) {
    let redraw = this._needsRedraw;
    if (clearRedrawFlags) {
      this._needsRedraw = false;
    }

    // This layers list doesn't include sublayers, relying on composite layers
    for (const layer of this.layers) {
      // Call every layer to clear their flags
      const layerNeedsRedraw = layer.getNeedsRedraw({clearRedrawFlags});
      redraw = redraw || layerNeedsRedraw;
    }

    return redraw;
  }

  // Match all layers, checking for caught errors
  // To avoid having an exception in one layer disrupt other layers
  // TODO - mark layers with exceptions as bad and remove from rendering cycle?
  _updateLayers({oldLayers, newLayers}) {
    // Create old layer map
    const oldLayerMap = {};
    for (const oldLayer of oldLayers) {
      if (oldLayerMap[oldLayer.id]) {
        log.warn(`Multiple old layers with same id ${layerName(oldLayer)}`);
      } else {
        oldLayerMap[oldLayer.id] = oldLayer;
      }
    }

    // Allocate array for generated layers
    const generatedLayers = [];

    // Match sublayers
    const error = this._updateSublayersRecursively({
      newLayers,
      oldLayerMap,
      generatedLayers
    });

    // Finalize unmatched layers
    const error2 = this._finalizeOldLayers(oldLayerMap);

    const firstError = error || error2;
    return {error: firstError, generatedLayers};
  }

  // Note: adds generated layers to `generatedLayers` array parameter
  _updateSublayersRecursively({newLayers, oldLayerMap, generatedLayers}) {
    let error = null;

    for (const newLayer of newLayers) {
      newLayer.context = this.context;

      // Given a new coming layer, find its matching old layer (if any)
      const oldLayer = oldLayerMap[newLayer.id];
      if (oldLayer === null) {
        // null, rather than undefined, means this id was originally there
        log.warn(`Multiple new layers with same id ${layerName(newLayer)}`);
      }
      // Remove the old layer from candidates, as it has been matched with this layer
      oldLayerMap[newLayer.id] = null;

      let sublayers = null;

      // We must not generate exceptions until after layer matching is complete
      try {
        if (!oldLayer) {
          this._initializeLayer(newLayer);
          initLayerInSeer(newLayer); // Initializes layer in seer chrome extension (if connected)
        } else {
          this._transferLayerState(oldLayer, newLayer);
          this._updateLayer(newLayer);
          updateLayerInSeer(newLayer); // Updates layer in seer chrome extension (if connected)
        }
        generatedLayers.push(newLayer);

        // Call layer lifecycle method: render sublayers
        sublayers = newLayer.isComposite && newLayer.getSubLayers();
        // End layer lifecycle method: render sublayers
      } catch (err) {
        log.warn(`error during matching of ${layerName(newLayer)}`, err);
        error = error || err; // Record first exception
      }

      if (sublayers) {
        this._updateSublayersRecursively({
          newLayers: sublayers,
          oldLayerMap,
          generatedLayers
        });
      }
    }

    return error;
  }

  // Finalize any old layers that were not matched
  _finalizeOldLayers(oldLayerMap) {
    let error = null;
    for (const layerId in oldLayerMap) {
      const layer = oldLayerMap[layerId];
      if (layer) {
        error = error || this._finalizeLayer(layer);
      }
    }
    return error;
  }

  // Initializes a single layer, calling layer methods
  _initializeLayer(layer) {
    log(LOG_PRIORITY_LIFECYCLE, `initializing ${layerName(layer)}`);

    let error = null;
    try {
      layer._initialize();
      layer.lifecycle = LIFECYCLE.INITIALIZED;
    } catch (err) {
      log.warn(`error while initializing ${layerName(layer)}\n`, err);
      error = error || err;
      // TODO - what should the lifecycle state be here? LIFECYCLE.INITIALIZATION_FAILED?
    }

    // Set back pointer (used in picking)
    layer.internalState.layer = layer;

    // Save layer on model for picking purposes
    // store on model.userData rather than directly on model
    for (const model of layer.getModels()) {
      model.userData.layer = layer;
    }

    return error;
  }

  _transferLayerState(oldLayer, newLayer) {
    if (newLayer !== oldLayer) {
      log(LOG_PRIORITY_LIFECYCLE_MINOR, `matched ${layerName(newLayer)}`, oldLayer, '->', newLayer);
      newLayer.lifecycle = LIFECYCLE.MATCHED;
      oldLayer.lifecycle = LIFECYCLE.AWAITING_GC;
      newLayer._transferState(oldLayer);
    } else {
      log.log(LOG_PRIORITY_LIFECYCLE_MINOR, `Matching layer is unchanged ${newLayer.id}`);
      newLayer.lifecycle = LIFECYCLE.MATCHED;
      newLayer.oldProps = newLayer.props;
    }
  }

  // Updates a single layer, cleaning all flags
  _updateLayer(layer) {
    log.log(LOG_PRIORITY_LIFECYCLE_MINOR, `updating ${layer} because: ${layer.printChangeFlags()}`);
    let error = null;
    try {
      layer._update();
    } catch (err) {
      log.warn(`error during update of ${layerName(layer)}`, err);
      // Save first error
      error = err;
    }
    return error;
  }

  // Finalizes a single layer
  _finalizeLayer(layer) {
    assert(layer.lifecycle !== LIFECYCLE.AWAITING_FINALIZATION);
    layer.lifecycle = LIFECYCLE.AWAITING_FINALIZATION;
    let error = null;
    this.setNeedsRedraw(`finalized ${layerName(layer)}`);
    try {
      layer._finalize();
    } catch (err) {
      log.warn(`error during finalization of ${layerName(layer)}`, err);
      error = err;
    }
    layer.lifecycle = LIFECYCLE.FINALIZED;
    log(LOG_PRIORITY_LIFECYCLE, `finalizing ${layerName(layer)}`);
    return error;
  }

  // SEER INTEGRATION

  /**
   * Called upon Seer initialization, manually sends layers data.
   */
  _initSeer() {
    this.layers.forEach(layer => {
      initLayerInSeer(layer);
      updateLayerInSeer(layer);
    });
  }

  /**
   * On Seer property edition, set override and update layers.
   */
  _editSeer(payload) {
    if (payload.type !== 'edit' || payload.valuePath[0] !== 'props') {
      return;
    }

    setPropOverrides(payload.itemKey, payload.valuePath.slice(1), payload.value);
    const newLayers = this.layers.map(layer => new layer.constructor(layer.props));
    this.updateLayers({newLayers});
  }
}
