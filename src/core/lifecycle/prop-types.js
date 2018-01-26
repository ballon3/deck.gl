import assert from 'assert';

export function parsePropTypes(propDefs) {
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
function parsePropType(name, propDef) {
  switch (getTypeOf(propDef)) {
    case 'object':
      propDef = normalizePropDefinition(name, propDef);
      return parsePropDefinition(propDef);

    case 'array':
      return guessArrayType(name, propDef);

    case 'boolean':
      return {name, type: 'boolean', value: propDef};

    case 'number':
      return guessNumberType(name, propDef);

    case 'function':
      return {name, type: 'function', value: propDef};
    // return guessFunctionType(name, propDef);

    default:
      return {name, type: 'unknown', value: propDef};
  }
}

function guessArrayType(name, array) {
  if (/color/i.test(name) && (array.length === 3 || array.length === 4)) {
    return {name, type: 'color', value: array};
  }
  return {name, type: 'array', value: array};
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

function guessNumberType(name, value) {
  const isKnownProp =
    /radius|scale|width|height|pixel|size|miter/i.test(name) &&
    /^((?!scale).)*$/.test(name);
  const max = isKnownProp ? 100 : 1;
  const min = 0;
  return {
    name,
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
