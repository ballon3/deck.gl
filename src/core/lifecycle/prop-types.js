import assert from 'assert';

export function parsePropTypes(propDefs, layerClass) {
  const propTypes = {};
  const defaultProps = {};
  for (const [propName, propDef] of Object.entries(propDefs)) {
    const propType = parsePropType(propName, propDef);
    propTypes[propName] = propType;
    defaultProps[propName] = propType.value;
  }
  return {propTypes, defaultProps};
}

// Parses one property definition entry. Either contains:
// * a valid prop type object ({type, ...})
// * or just a default value, in which case type and name inference is used
function parsePropType(propName, propDef) {
  switch (getTypeOf(propDef)) {
    case 'object':
      propDef = normalizePropDefinition(propName, propDef);
      return parsePropDefinition(propDef);

    case 'array':
      return guessArrayType(propName, propDef);

    case 'boolean':
      return {type: 'boolean', max: true, min: false, value: propDef};

    case 'number':
      return guessNumberType(propName, propDef);

    case 'function':
      return {type: 'function', value: propDef};
    // return guessFunctionType(propName, propDef);

    default:
      return {type: 'unknown', value: propDef};
  }
}

function guessArrayType(propName, array) {
  if (/color/i.test(propName)) {
    if (array.length === 3 || array.length === 4) {
      return {type: 'color', value: array};
    }
  }
  return {type: 'array', value: array};
}

function normalizePropDefinition(name, propDef) {
  if (!('type' in propDef)) {
    if (!('value' in propDef)) {
      // If no type and value this object is likely the value
      return {name, type: 'object', value: propDef};
    }
    return Object.assign({name, type: getTypeOf(propDef.value)}, propDef);
  }
  return Object.assign({name}, propDef);
}

function parsePropDefinition(propDef) {
  switch (propDef.type) {
    case 'number':
      assert(
        'value' in propDef &&
          (!('max' in propDef) || Number.isFinite(propDef.max)) &&
          (!('min' in propDef) || Number.isFinite(propDef.min))
      );
      // TODO check that value is in [min, max]
      break;

    case 'boolean':
    case 'array':
    case 'data':
    default:
      break;

    case undefined:
      assert(false);
  }

  return propDef;
}

function guessNumberType(propName, value) {
  const isKnownProp =
    /radius|scale|width|height|pixel|size|miter/i.test(propName) &&
    /^((?!scale).)*$/.test(propName);
  const max = isKnownProp ? 100 : 1;
  const min = 0;
  return {
    type: 'number',
    max: Math.max(value, max),
    min: Math.min(value, min),
    value
  };
}

// improved version of javascript typeof that can distinguish arrays and null values
function getTypeOf(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}
