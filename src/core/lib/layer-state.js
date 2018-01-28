import Stats from './stats';
import assert from 'assert';

const EMPTY_ARRAY = Object.freeze([]);

export default class LayerState {
  constructor({attributeManager}) {
    assert(attributeManager);
    this.attributeManager = attributeManager;
    this.model = null;
    this.needsRedraw = true;
    this.subLayers = null; // reference to sublayers rendered in a previous cycle
    this.stats = new Stats({id: 'draw'});
    this.layer = null;
    this.asyncValues = {};
    // this.animatedProps = null, // Computing animated props requires layer manager state
  }

  getAsyncProp(propName, props) {
    return propName in this.asyncValues
      ? this.asyncValues[propName].value
      : props._shadowValues[propName];
  }

  updateAsyncProps(props) {
    this.setAsyncProp('data', props._shadowValues.data, props);
  }

  setAsyncProp(propName, value, props) {
    // Intercept strings and promises
    const type = value instanceof Promise ? 'Promise' : typeof value;

    switch (type) {
      case 'string':
        const {fetch, dataTransform} = props;

        const asyncProp = this._getAsyncProp(propName, props._shadowValues[propName]);
        if (value === asyncProp.lastValue) {
          return false;
        }
        asyncProp.lastValue = value;

        // interpret value string as url and start a new load
        const url = value;
        this._loadAsyncProp({url, asyncProp, fetch, dataTransform});
        break;

      default:
        // Remove entry from map, disabled shadowing
        delete this.asyncValues[propName];
    }
    return false;
  }

  _getAsyncProp(propName, value) {
    // assert(propName && this.layer);
    this.asyncValues[propName] = this.asyncValues[propName] || {
      lastValue: null, // Original value is stored here
      loadValue: null, // Auto loaded data is stored here
      loadPromise: null, // Auto load promise
      loadCount: 0,
      value: EMPTY_ARRAY
    };

    return this.asyncValues[propName];
  }

  _loadAsyncProp({url, asyncProp, fetch, dataTransform}) {
    // Set data to ensure props.data does not return a string
    // Note: Code in LayerProps class depends on this
    asyncProp.data = asyncProp.data || [];

    // Closure will track counter to make sure we only update on last load
    const count = ++asyncProp.loadCount;

    // Load the data
    asyncProp.loadPromise = fetch(url)
      .then(data => dataTransform(data))
      .then(data => {
        if (count === asyncProp.loadCount) {
          asyncProp.loadValue = data;
          asyncProp.loadPromise = null;
          asyncProp.value = data;
          this.layer.setChangeFlags({dataChanged: true});
        }
      });
  }
}
