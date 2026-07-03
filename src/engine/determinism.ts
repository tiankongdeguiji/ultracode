/**
 * Hardening bootstrap executed inside the vm context BEFORE the workflow
 * script. Mirrors the reference implementations (Claude Code / Qoder):
 * entropy sources that would break prefix-replay resume throw with
 * instructive messages, escape-prone globals are removed, and intrinsic
 * prototypes are frozen.
 *
 * NOTE: node:vm is a capability-scoping and determinism device here, not a
 * hostile-code boundary — scripts are model-authored and user-reviewed.
 */

export const BAN_MESSAGES = {
  dateNow: 'Date.now() is unavailable in workflow scripts; pass timestamps via args.',
  dateNoArgs: 'Date() without arguments is unavailable in workflow scripts; pass timestamps via args.',
  mathRandom: 'Math.random() is unavailable in workflow scripts; pass deterministic values via args.',
} as const;

/**
 * Intrinsics whose prototype + constructor get frozen. Kept as a named list
 * so tests can assert coverage.
 */
export const FROZEN_INTRINSICS = [
  'Object',
  'Array',
  'Function',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'RegExp',
  'Promise',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'ArrayBuffer',
  'DataView',
  'Uint8Array',
  'Int32Array',
  'Float64Array',
  'JSON',
] as const;

export const HARDENING_BOOTSTRAP = `
'use strict';
(() => {
  const RealDate = Date;
  function GuardedDate(...a) {
    if (new.target) {
      if (a.length === 0) {
        throw new Error(${JSON.stringify(BAN_MESSAGES.dateNoArgs)});
      }
      return Reflect.construct(RealDate, a);
    }
    throw new Error(${JSON.stringify(BAN_MESSAGES.dateNoArgs)});
  }
  GuardedDate.prototype = RealDate.prototype;
  GuardedDate.parse = RealDate.parse.bind(RealDate);
  GuardedDate.UTC = RealDate.UTC.bind(RealDate);
  GuardedDate.now = () => {
    throw new Error(${JSON.stringify(BAN_MESSAGES.dateNow)});
  };
  Object.defineProperty(globalThis, 'Date', { value: GuardedDate, writable: false, configurable: false });

  Math.random = () => {
    throw new Error(${JSON.stringify(BAN_MESSAGES.mathRandom)});
  };

  delete globalThis.WebAssembly;
  delete globalThis.ShadowRealm;
  delete globalThis.Atomics;
  delete globalThis.SharedArrayBuffer;

  const freezeIntrinsic = (name) => {
    const it = globalThis[name];
    if (!it) return;
    if (it.prototype) Object.freeze(it.prototype);
    Object.freeze(it);
  };
  for (const name of ${JSON.stringify([...FROZEN_INTRINSICS])}) freezeIntrinsic(name);
  Object.freeze(Math);
  Object.freeze(Reflect);
  Object.freeze(GuardedDate);
})();
`;
