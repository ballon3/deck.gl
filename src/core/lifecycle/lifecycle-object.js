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

import {LIFECYCLE} from './constants';
import {diffProps} from './props';
import log from '../utils/log';
import {removeLayerInSeer} from './seer-integration';
import {getLayerProps} from './layer-props';
import LayerState from './layer-state';
import assert from 'assert';

const LOG_PRIORITY_UPDATE = 1;
const EMPTY_PROPS = {};
Object.freeze(EMPTY_PROPS);

let counter = 0;

export default class LayerObject {
  constructor(props = {}) {
    // Merges the incoming props with defaults and freeze them.
    const Props = getLayerProps(this);
    this.props = new Props(props, this);

    // Define all members before layer is sealed
    this.id = this.props.id; // The layer's id, used for matching with layers from last render cycle
    this.oldProps = EMPTY_PROPS; // Props from last render used for change detection
    this.count = counter++; // Keep track of how many layer instances you are generating
    this.lifecycle = LIFECYCLE.NO_STATE; // Helps track and debug the life cycle of the layers
    this.parentLayer = null; // reference to the composite layer parent that rendered this layer
    this.context = null; // Will reference layer manager's context, contains state shared by layers
    this.state = null; // Will be set to the shared layer state object during layer matching
    this.internalState = null;

    // Seal the layer
    Object.seal(this);
  }

  // clone this layer with modified props
  clone(newProps) {
    return new this.constructor(Object.assign({}, this.props, newProps));
  }

  toString() {
    const className = this.constructor.layerName || this.constructor.name;
    return `${className}({id: '${this.props.id}'})`;
  }

  get stats() {
    return this.internalState.stats;
  }

  // Public API

  // Updates selected state members and marks the object for redraw
  setState(updateObject) {
    Object.assign(this.state, updateObject);
    this.setNeedsRedraw();
  }

  // Sets the redraw flag for this layer, will trigger a redraw next animation frame
  setNeedsRedraw(redraw = true) {
    if (this.internalState) {
      this.internalState.needsRedraw = redraw;
    }
  }

  // Checks state of attributes and model
  getNeedsRedraw({clearRedrawFlags = false} = {}) {
    return this._getNeedsRedraw(clearRedrawFlags);
  }

  // Sets the update flag for this layer, will trigger a redraw next animation frame
  // setNeedsUpdate(update = true) {
  //   if (this.internalState) {
  //     this.internalState.needsUpdate = update;
  //   }
  // }

  // Checks if layer attributes needs updating
  needsUpdate() {
    // Call subclass lifecycle method
    return this.shouldUpdateState(this._getUpdateParams());
    // End lifecycle method
  }

  getCurrentLayer() {
    return this.internalState && this.internalState.layer;
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

  // END LIFECYCLE METHODS
  // //////////////////////////////////////////////////

  // Update attribute transition
  updateTransition() {
    const model = this.getSingleModel();
    const attributeManager = this.getAttributeManager();
    const isInTransition = attributeManager && attributeManager.updateTransition();

    if (model && isInTransition) {
      model.setAttributes(attributeManager.getChangedAttributes({transition: true}));
    }
  }

  // LAYER MANAGER API
  // Should only be called by the deck.gl LayerManager class

  // Called by layer manager when a new layer is found
  /* eslint-disable max-statements */
  _initialize() {
    assert(arguments.length === 0);
    assert(!this.internalState && !this.state);

    this.internalState = new LayerState({});
    this.state = {};

    // Call subclass lifecycle methods
    this.initializeState(this.context);
    // End subclass lifecycle methods

    // initializeState callback tends to clear state
    this.setChangeFlags({dataChanged: true, propsChanged: true, viewportChanged: true});
    this._loadData();

    this._updateState(this._getUpdateParams());

    // Last but not least, update any sublayers
    if (this.isComposite) {
      this._renderLayers();
    }

    this.clearChangeFlags();
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
  }

  // Called by manager when layer is about to be disposed
  // Note: not guaranteed to be called on application shutdown
  _finalize() {
    assert(this.internalState && this.state);
    assert(arguments.length === 0);
    // Call subclass lifecycle method
    this.finalizeState(this.context);
    // End lifecycle method
    removeLayerInSeer(this.id);
  }

  // Helper methods
  getChangeFlags() {
    return this.internalState.changeFlags;
  }

  // Dirty some change flags, will be handled by updateLayer
  /* eslint-disable complexity */
  setChangeFlags(flags) {
    this.internalState.changeFlags = this.internalState.changeFlags || {};
    const changeFlags = this.internalState.changeFlags;

    // Update primary flags
    if (flags.dataChanged && !changeFlags.dataChanged) {
      changeFlags.dataChanged = flags.dataChanged;
      log.log(LOG_PRIORITY_UPDATE + 1, () => `dataChanged: ${flags.dataChanged} in ${this.id}`);
    }
    if (flags.updateTriggersChanged && !changeFlags.updateTriggersChanged) {
      changeFlags.updateTriggersChanged =
        changeFlags.updateTriggersChanged && flags.updateTriggersChanged
          ? Object.assign({}, flags.updateTriggersChanged, changeFlags.updateTriggersChanged)
          : flags.updateTriggersChanged || changeFlags.updateTriggersChanged;
      log.log(
        LOG_PRIORITY_UPDATE + 1,
        () =>
          'updateTriggersChanged: ' +
          `${Object.keys(flags.updateTriggersChanged).join(', ')} in ${this.id}`
      );
    }
    if (flags.propsChanged && !changeFlags.propsChanged) {
      changeFlags.propsChanged = flags.propsChanged;
      log.log(LOG_PRIORITY_UPDATE + 1, () => `propsChanged: ${flags.propsChanged} in ${this.id}`);
    }
    if (flags.viewportChanged && !changeFlags.viewportChanged) {
      changeFlags.viewportChanged = flags.viewportChanged;
      log.log(
        LOG_PRIORITY_UPDATE + 2,
        () => `viewportChanged: ${flags.viewportChanged} in ${this.id}`
      );
    }

    // Update composite flags
    const propsOrDataChanged =
      flags.dataChanged || flags.updateTriggersChanged || flags.propsChanged;
    changeFlags.propsOrDataChanged = changeFlags.propsOrDataChanged || propsOrDataChanged;
    changeFlags.somethingChanged =
      changeFlags.somethingChanged || propsOrDataChanged || flags.viewportChanged;
  }
  /* eslint-enable complexity */

  // Clear all changeFlags, typically after an update
  clearChangeFlags() {
    this.internalState.changeFlags = {
      // Primary changeFlags, can be strings stating reason for change
      dataChanged: false,
      propsChanged: false,
      updateTriggersChanged: false,
      viewportChanged: false,

      // Derived changeFlags
      propsOrDataChanged: false,
      somethingChanged: false
    };
  }

  printChangeFlags() {
    const flags = this.internalState.changeFlags;
    return `\
${flags.dataChanged ? 'data ' : ''}\
${flags.propsChanged ? 'props ' : ''}\
${flags.updateTriggersChanged ? 'triggers ' : ''}\
${flags.viewportChanged ? 'viewport' : ''}\
`;
  }

  // Compares the layers props with old props from a matched older layer
  // and extracts change flags that describe what has change so that state
  // can be update correctly with minimal effort
  // TODO - arguments for testing only
  diffProps(newProps = this.props, oldProps = this.oldProps) {
    const changeFlags = diffProps(newProps, oldProps);

    // iterate over changedTriggers
    if (changeFlags.updateTriggersChanged) {
      for (const key in changeFlags.updateTriggersChanged) {
        if (changeFlags.updateTriggersChanged[key]) {
          this._activeUpdateTrigger(key);
        }
      }
    }

    if (changeFlags.dataChanged) {
      if (this._loadData()) {
        // Postpone data changed flag until loaded
        changeFlags.dataChanged = false;
      }
    }

    return this.setChangeFlags(changeFlags);
  }

  _loadData() {
    const {data, fetch} = this.props;
    switch (typeof data) {
      case 'string':
        const url = data;
        if (url !== this.internalState.lastUrl) {
          // Make sure pros.data returns an Array, not a string

          this.internalState.data = this.internalState.data || [];
          this.internalState.lastUrl = url;

          // Load the data
          const promise = fetch(url).then(loadedData => {
            this.internalState.data = loadedData;
            this.setChangeFlags({dataChanged: true});
          });

          this.internalState.loadPromise = promise;
          return true;
        }
        break;
      default:
        // Makes getData() return props.data
        this.internalState.data = null;
    }
    return false;
  }

  // PRIVATE METHODS

  _getUpdateParams() {
    return {
      props: this.props,
      oldProps: this.oldProps,
      context: this.context,
      oldContext: this.oldContext || {},
      changeFlags: this.internalState.changeFlags
    };
  }

  // Checks state of attributes and model
  _getNeedsRedraw(clearRedrawFlags) {
    // this method may be called by the render loop as soon a the layer
    // has been created, so guard against uninitialized state
    if (!this.internalState) {
      return false;
    }

    let redraw = false;
    redraw = redraw || (this.internalState.needsRedraw && this.id);
    this.internalState.needsRedraw = this.internalState.needsRedraw && !clearRedrawFlags;

    return redraw;
  }

  // Called by layer manager to transfer state from an old layer
  _transferState(oldLayer) {
    const {state, internalState, props} = oldLayer;
    assert(state && internalState);

    // Move state
    state.layer = this;
    this.state = state;
    this.internalState = internalState;
    // Note: We keep the state ref on old layers to support async actions
    // oldLayer.state = null;

    // Keep a temporary ref to the old props, for prop comparison
    this.oldProps = props;

    // Update model layer reference
    for (const model of this.getModels()) {
      model.userData.layer = this;
    }

    this.diffProps();
  }

  // Operate on each changed triggers, will be called when an updateTrigger changes
  _activeUpdateTrigger(propName) {
    this.invalidateAttribute(propName);
  }

  //  Helper to check that required props are supplied
  _checkRequiredProp(propertyName, condition) {
    const value = this.props[propertyName];
    if (value === undefined) {
      throw new Error(`Property ${propertyName} undefined in layer ${this}`);
    }
    if (condition && !condition(value)) {
      throw new Error(`Bad property ${propertyName} in layer ${this}`);
    }
  }
}
