import {applyPropOverrides} from '../lib/seer-integration';
import log from '../utils/log';
import {parsePropTypes} from './prop-types';

export const EMPTY_ARRAY = Object.freeze([]);

// const ASYNC_PROPS = {
//   // Accept null as data - otherwise apps and layers need to add ugly checks
//   // Use constant fallback so that data change is not triggered
//   data: EMPTY_ARRAY
// };

// Create a property object
export function createProps() {
  const layer = this; // eslint-disable-line

  // Get default prop object (a prototype chain for now)
  const {defaultProps} = getDefaultProps(layer.constructor);

  // Create a new prop object with  default props object in prototype chain
  const newProps = Object.create(defaultProps, {
    _layer: {
      enumerable: false,
      value: layer
    },
    _asyncProps: {
      enumerable: false,
      value: {}
    }
  });

  // "Copy" all sync props
  for (let i = 0; i < arguments.length; ++i) {
    Object.assign(newProps, arguments[i]);
  }
  newProps.data = newProps.data || EMPTY_ARRAY;

  // SEER: Apply any overrides from the seer debug extension if it is active
  applyPropOverrides(newProps);

  // Props must be immutable
  Object.freeze(newProps);

  return newProps;
}

// function setAsyncProps(newProps, props, asyncProps) {
//   for (const propName in asyncProps) {
//     let value;
//     if (propName in props) {
//       value = props[propName];
//       delete props[propName];
//     } else {
//       value = asyncProps[propName];
//     }
//     newProps._asyncProps[propName] = value;
//   }
//   return props;
// }

// Helper methods

// Constructors have their super class constructors as prototypes
function getOwnProperty(object, prop) {
  return Object.prototype.hasOwnProperty.call(object, prop) && object[prop];
}

function getLayerName(layerClass) {
  const layerName = getOwnProperty(layerClass, 'layerName');
  if (!layerName) {
    log.once(0, `Layer ${layerClass.name} does not specify a ${layerName}`);
  }
  return layerName || layerClass.name;
}

// Return precalculated defaultProps and propType objects if available
// build them if needed
function getPropDefs(layerClass) {
  const props = getOwnProperty(layerClass, '_mergedDefaultProps');
  if (props) {
    return {
      defaultProps: props,
      propTypes: getOwnProperty(layerClass, '_propTypes')
    };
  }

  return buildPropDefs(layerClass);
}

// Build defaultProps and propType objects by walking layer prototype chain
function buildPropDefs(layerClass) {
  const parent = layerClass.prototype;
  const parentClass = Object.getPrototypeOf(layerClass);
  const parentPropDefs = (parent && getPropDefs(parentClass)) || null;

  // Parse propTypes from Layer.defaultProps
  const layerDefaultProps = getOwnProperty(layerClass, 'defaultProps') || {};
  const layerPropDefs = parsePropTypes(layerDefaultProps);

  // Create a merged type object
  const propTypes = Object.assign(
    {},
    parentPropDefs && parentPropDefs.propTypes,
    layerPropDefs.propTypes
  );

  // Create any necessary property descriptors and create the default prop object
  // Assign merged default props
  const defaultProps = buildDefaultProps(
    layerPropDefs.defaultProps,
    parentPropDefs && parentPropDefs.defaultProps,
    propTypes,
    layerClass
  );

  // Store the precalculated props
  layerClass._mergedDefaultProps = defaultProps;
  layerClass._propTypes = propTypes;

  return {propTypes, defaultProps};
}

function buildDefaultProps(props, parentProps, propTypes, layerClass) {
  const defaultProps = Object.create(null);

  Object.assign(defaultProps, parentProps, props);

  const descriptors = {};

  const id = getLayerName(layerClass);
  delete props.id;

  Object.assign(descriptors, {
    id: {
      configurable: false,
      writable: true,
      value: id
    }
  });

  // if ('data' in propTypes) {
  //   delete props.data;
  //   Object.assign(descriptors, {
  //     data: {
  //       configurable: false,
  //       get() { return this._layer.getAsyncProp(this, 'data'); }
  //     }
  //   });
  // }

  Object.defineProperties(defaultProps, descriptors);

  return defaultProps;
}
