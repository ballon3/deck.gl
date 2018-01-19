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

/* global window */
/* global fetch */
import LayerObject from 'layer-object';
import {COORDINATE_SYSTEM} from './constants';
import AttributeManager from './attribute-manager';
import {count} from '../utils/count';
import log from '../utils/log';
import {GL, withParameters} from 'luma.gl';
import assert from 'assert';

const LOG_PRIORITY_UPDATE = 1;
const EMPTY_PROPS = {};
Object.freeze(EMPTY_PROPS);

const noop = () => {};

const defaultProps = {
  // data: Special handling for null, see below
  dataComparator: null,
  fetch: url => fetch(url).then(response => response.json()),
  updateTriggers: {}, // Update triggers: a core change detection mechanism in deck.gl
  numInstances: undefined,

  visible: true,
  pickable: false,
  opacity: 0.8,

  onHover: noop,
  onClick: noop,

  coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
  coordinateOrigin: [0, 0, 0],

  parameters: {},
  uniforms: {},
  framebuffer: null,

  animation: null, // Passed prop animation functions to evaluate props

  // Offset depth based on layer index to avoid z-fighting.
  // Negative values pull layer towards the camera
  // https://www.opengl.org/archives/resources/faq/technical/polygonoffset.htm
  getPolygonOffset: ({layerIndex}) => [0, -layerIndex * 100],

  // Selection/Highlighting
  highlightedObjectIndex: null,
  autoHighlight: false,
  highlightColor: [0, 0, 128, 128]
};

export default class Layer extends LayerObject {
  // Public API
  constructor(props = {}) {
    super(props);
  }

  // Returns true if the layer is pickable and visible.
  isPickable() {
    return this.props.pickable && this.props.visible;
  }

  // Return an array of models used by this layer, can be overriden by layer subclass
  getModels() {
    return this.state && (this.state.models || (this.state.model ? [this.state.model] : []));
  }

  // TODO - Gradually phase out, does not support multi model layers
  getSingleModel() {
    return this.state && this.state.model;
  }

  getAttributeManager() {
    return this.internalState && this.internalState.attributeManager;
  }

  // Use iteration (the only required capability on data) to get first element
  // deprecated since we are effectively only supporting Arrays
  getFirstObject() {
    const {data} = this.props;
    for (const object of data) {
      return object;
    }
    return null;
  }

  // PROJECTION METHODS

  // Projects a point with current map state (lat, lon, zoom, pitch, bearing)
  // TODO - need to be extended to work with multiple `views`
  project(lngLat) {
    const {viewport} = this.context;
    assert(Array.isArray(lngLat));
    return viewport.project(lngLat);
  }

  unproject(xy) {
    const {viewport} = this.context;
    assert(Array.isArray(xy));
    return viewport.unproject(xy);
  }

  projectFlat(lngLat) {
    const {viewport} = this.context;
    assert(Array.isArray(lngLat));
    return viewport.projectFlat(lngLat);
  }

  unprojectFlat(xy) {
    const {viewport} = this.context;
    assert(Array.isArray(xy));
    return viewport.unprojectFlat(xy);
  }

  // TODO - needs to refer to context for devicePixels setting
  screenToDevicePixels(screenPixels) {
    log.deprecated('screenToDevicePixels', 'DeckGL prop useDevicePixels for conversion');
    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return screenPixels * devicePixelRatio;
  }

  // Returns the picking color that doesn't match any subfeature
  // Use if some graphics do not belong to any pickable subfeature
  // @return {Array} - a black color
  nullPickingColor() {
    return [0, 0, 0];
  }

  // Returns the picking color that doesn't match any subfeature
  // Use if some graphics do not belong to any pickable subfeature
  encodePickingColor(i) {
    assert((((i + 1) >> 24) & 255) === 0, 'index out of picking color range');
    return [(i + 1) & 255, ((i + 1) >> 8) & 255, (((i + 1) >> 8) >> 8) & 255];
  }

  // Returns the index corresponding to a picking color that doesn't match any subfeature
  // @param {Uint8Array} color - color array to be decoded
  // @return {Array} - the decoded picking color
  decodePickingColor(color) {
    assert(color instanceof Uint8Array);
    const [i1, i2, i3] = color;
    // 1 was added to seperate from no selection
    const index = i1 + i2 * 256 + i3 * 65536 - 1;
    return index;
  }

  // //////////////////////////////////////////////////
  // LIFECYCLE METHODS, overridden by the layer subclasses

  // Called once to set up the initial state
  // App can create WebGL resources
  initializeState() {
    throw new Error(`Layer ${this} has not defined initializeState`);
  }

  // Let's layer control if updateState should be called
  shouldUpdateState({oldProps, props, oldContext, context, changeFlags}) {
    return changeFlags.propsOrDataChanged;
  }

  // Default implementation, all attributes will be invalidated and updated
  // when data changes
  updateState({oldProps, props, oldContext, context, changeFlags}) {
    const attributeManager = this.getAttributeManager();
    if (changeFlags.dataChanged && attributeManager) {
      attributeManager.invalidateAll();
    }
  }

  // Called once when layer is no longer matched and state will be discarded
  // App can destroy WebGL resources here
  finalizeState() {}

  // If state has a model, draw it with supplied uniforms
  draw(opts) {
    for (const model of this.getModels()) {
      model.draw(opts);
    }
  }

  // called to populate the info object that is passed to the event handler
  // @return null to cancel event
  getPickingInfo({info, mode}) {
    const {index} = info;

    if (index >= 0) {
      // If props.data is an indexable array, get the object
      if (Array.isArray(this.props.data)) {
        info.object = this.props.data[index];
      }
    }

    return info;
  }

  // END LIFECYCLE METHODS
  // //////////////////////////////////////////////////

  // INTERNAL METHODS

  // Deduces numer of instances. Intention is to support:
  // - Explicit setting of numInstances
  // - Auto-deduction for ES6 containers that define a size member
  // - Auto-deduction for Classic Arrays via the built-in length attribute
  // - Auto-deduction via arrays
  getNumInstances(props) {
    props = props || this.props;

    // First check if the layer has set its own value
    if (this.state && this.state.numInstances !== undefined) {
      return this.state.numInstances;
    }

    // Check if app has provided an explicit value
    if (props.numInstances !== undefined) {
      return props.numInstances;
    }

    // Use container library to get a count for any ES6 container or object
    const {data} = this.props;
    return count(data);
  }

  // Default implementation of attribute invalidation, can be redefined
  invalidateAttribute(name = 'all', diffReason = '') {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) {
      return;
    }

    if (name === 'all') {
      log.log(LOG_PRIORITY_UPDATE, `updateTriggers invalidating all attributes: ${diffReason}`);
      attributeManager.invalidateAll();
    } else {
      log.log(LOG_PRIORITY_UPDATE, `updateTriggers invalidating attribute ${name}: ${diffReason}`);
      attributeManager.invalidate(name);
    }
  }

  // Calls attribute manager to update any WebGL attributes
  updateAttributes(props) {
    const attributeManager = this.getAttributeManager();

    // Figure out data length
    const numInstances = this.getNumInstances(props);

    attributeManager.update({
      data: props.data,
      numInstances,
      props,
      transitions: props.transitions,
      buffers: props,
      context: this,
      // Don't worry about non-attribute props
      ignoreUnknownAttributes: true
    });

    const model = this.getSingleModel();
    if (model) {
      const changedAttributes = attributeManager.getChangedAttributes({clearChangedFlags: true});
      model.setAttributes(changedAttributes);
    }
  }

  // Update attribute transition
  updateTransition() {
    const model = this.getSingleModel();
    const attributeManager = this.getAttributeManager();
    const isInTransition = attributeManager && attributeManager.updateTransition();

    if (model && isInTransition) {
      model.setAttributes(attributeManager.getChangedAttributes({transition: true}));
    }
  }

  calculateInstancePickingColors(attribute, {numInstances}) {
    const {value, size} = attribute;
    // add 1 to index to seperate from no selection
    for (let i = 0; i < numInstances; i++) {
      const pickingColor = this.encodePickingColor(i);
      value[i * size + 0] = pickingColor[0];
      value[i * size + 1] = pickingColor[1];
      value[i * size + 2] = pickingColor[2];
    }
  }

  // LAYER MANAGER API
  // Should only be called by the deck.gl LayerManager class

  // Called by layer manager when a new layer is found
  /* eslint-disable max-statements */
  _initialize() {
    const attributeManager = new AttributeManager(this.context.gl, {
      id: this.props.id
    });

    // All instanced layers get instancePickingColors attribute by default
    // Their shaders can use it to render a picking scene
    // TODO - this slightly slows down non instanced layers
    attributeManager.addInstanced({
      instancePickingColors: {
        type: GL.UNSIGNED_BYTE,
        size: 3,
        update: this.calculateInstancePickingColors
      }
    });

    super.initialize({attributeManager});

    const model = this.getSingleModel();
    if (model) {
      model.id = this.props.id;
      model.program.id = `${this.props.id}-program`;
      model.geometry.id = `${this.props.id}-geometry`;
      model.setAttributes(attributeManager.getAttributes());
    }
  }

  // Called by layer manager
  // if this layer is new (not matched with an existing layer) oldProps will be empty object
  _update() {
    assert(arguments.length === 0);

    // Call subclass lifecycle method
    const stateNeedsUpdate = this.needsUpdate();
    // End lifecycle method

    const updateParams = {
      props: this.props,
      oldProps: this.oldProps,
      context: this.context,
      oldContext: this.oldContext,
      changeFlags: this.internalState.changeFlags
    };

    if (stateNeedsUpdate) {
      this._updateState(updateParams);
    }

    // Render or update previously rendered sublayers
    if (this.isComposite) {
      this._renderLayers(stateNeedsUpdate);
    }

    this.clearChangeFlags();
  }
  /* eslint-enable max-statements */

  _updateState(updateParams) {
    // Call subclass lifecycle methods
    this.updateState(updateParams);
    // End subclass lifecycle methods

    // Add any subclass attributes
    this.updateAttributes(this.props);
    this._updateBaseUniforms();
    this._updateModuleSettings();

    // Note: Automatic instance count update only works for single layers
    if (this.state.model) {
      this.state.model.setInstanceCount(this.getNumInstances());
    }
  }

  // Calculates uniforms
  drawLayer({moduleParameters = null, uniforms = {}, parameters = {}}) {
    if (!uniforms.picking_uActive) {
      this.updateTransition();
    }

    // TODO/ib - hack move to luma Model.draw
    if (moduleParameters) {
      for (const model of this.getModels()) {
        model.updateModuleSettings(moduleParameters);
      }
    }

    // Apply polygon offset to avoid z-fighting
    // TODO - move to draw-layers
    const {getPolygonOffset} = this.props;
    const offsets = (getPolygonOffset && getPolygonOffset(uniforms)) || [0, 0];
    parameters.polygonOffset = offsets;

    // Call subclass lifecycle method
    withParameters(this.context.gl, parameters, () => {
      this.draw({moduleParameters, uniforms, parameters, context: this.context});
    });
    // End lifecycle method
  }

  // {uniforms = {}, ...opts}
  pickLayer(opts) {
    // Call subclass lifecycle method
    return this.getPickingInfo(opts);
    // End lifecycle method
  }

  // Checks state of attributes and model
  _getNeedsRedraw(clearRedrawFlags) {
    let redraw = super._getNeedsRedraw(clearRedrawFlags);

    // TODO - is attribute manager needed? - Model should be enough.
    const attributeManager = this.getAttributeManager();
    const attributeManagerNeedsRedraw =
      attributeManager && attributeManager.getNeedsRedraw({clearRedrawFlags});
    redraw = redraw || attributeManagerNeedsRedraw;

    for (const model of this.getModels()) {
      let modelNeedsRedraw = model.getNeedsRedraw({clearRedrawFlags});
      if (modelNeedsRedraw && typeof modelNeedsRedraw !== 'string') {
        modelNeedsRedraw = `model ${model.id}`;
      }
      redraw = redraw || modelNeedsRedraw;
    }

    return redraw;
  }

  // Called by layer manager to transfer state from an old layer
  _transferState(oldLayer) {
    super._transferState(oldLayer);

    // Update model layer reference
    for (const model of this.getModels()) {
      model.userData.layer = this;
    }
  }

  // Operate on each changed triggers, will be called when an updateTrigger changes
  _activeUpdateTrigger(propName) {
    this.invalidateAttribute(propName);
  }

  _updateBaseUniforms() {
    const uniforms = {
      // apply gamma to opacity to make it visually "linear"
      opacity: Math.pow(this.props.opacity, 1 / 2.2),
      ONE: 1.0
    };
    for (const model of this.getModels()) {
      model.setUniforms(uniforms);
    }

    // TODO - set needsRedraw on the model(s)?
    this.setNeedsRedraw();
  }

  _updateModuleSettings() {
    const settings = {
      pickingHighlightColor: this.props.highlightColor
    };
    for (const model of this.getModels()) {
      model.updateModuleSettings(settings);
    }
  }

  // DEPRECATED METHODS

  // Updates selected state members and marks the object for redraw
  setUniforms(uniformMap) {
    for (const model of this.getModels()) {
      model.setUniforms(uniformMap);
    }

    // TODO - set needsRedraw on the model(s)?
    this.setNeedsRedraw();
    log.deprecated('layer.setUniforms', 'model.setUniforms');
  }
}

Layer.layerName = 'Layer';
Layer.defaultProps = defaultProps;
