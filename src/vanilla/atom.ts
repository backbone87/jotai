type Getter = <Value>(atom: Atom<Value>) => Value

type Setter = <Value, Args extends unknown[], Result>(
  atom: WritableAtom<Value, Args, Result>,
  ...args: Args
) => Result

type SetAtom<Args extends unknown[], Result> = <A extends Args>(
  ...args: A
) => Result

/**
 * setSelf is for internal use only and subject to change without notice.
 */
type Read<Value, SetSelf = never> = (
  get: Getter,
  options: { readonly signal: AbortSignal; readonly setSelf: SetSelf },
) => Value

type Write<Args extends unknown[], Result> = (
  get: Getter,
  set: Setter,
  ...args: Args
) => Result

// This is an internal type and not part of public API.
// Do not depend on it as it can change without notice.
type WithInitialValue<Value> = {
  init: Value
}

type OnUnmount = () => void

type OnMount<Args extends unknown[], Result> = <
  S extends SetAtom<Args, Result>,
>(
  setAtom: S,
) => OnUnmount | void

export interface Atom<Value> {
  toString: () => string
  is: typeof Object.is
  derived: boolean
  read: Read<Value>
  debugLabel?: string
  /**
   * To ONLY be used by Jotai libraries to mark atoms as private. Subject to change.
   * @private
   */
  debugPrivate?: boolean
}

export interface WritableAtom<Value, Args extends unknown[], Result>
  extends Atom<Value> {
  read: Read<Value, SetAtom<Args, Result>>
  write: Write<Args, Result>
  onMount?: OnMount<Args, Result>
}

type SetStateAction<Value> = Value | ((prev: Value) => Value)

export type PrimitiveAtom<Value> = WritableAtom<
  Value,
  [SetStateAction<Value>],
  void
>

let keyCount = 0 // global key count for all atoms

// writable derived atom
export function atom<Value, Args extends unknown[], Result>(
  read: Read<Value, SetAtom<Args, Result>>,
  write: Write<Args, Result>,
): WritableAtom<Value, Args, Result>

// read-only derived atom
export function atom<Value>(read: Read<Value>): Atom<Value>

// write-only derived atom
export function atom<Value, Args extends unknown[], Result>(
  initialValue: Value,
  write: Write<Args, Result>,
): WritableAtom<Value, Args, Result> & WithInitialValue<Value>

// primitive atom
export function atom<Value>(
  initialValue: Value,
): PrimitiveAtom<Value> & WithInitialValue<Value>

export function atom<Value, Args extends unknown[], Result>(
  initialValueOrRead: Value | Read<Value, SetAtom<Args, Result>>,
  maybeWrite?: Write<Args, Result>,
): Atom<Value> | PrimitiveAtom<Value> | WritableAtom<Value, Args, Result> {
  type R = Read<Value, SetAtom<Args, Result>>

  const key = `atom${++keyCount}`

  const toString = () => key
  const is = Object.is
  const derived = typeof initialValueOrRead === 'function'
  const read: R = derived ? (initialValueOrRead as R) : defaultRead
  let write:
    | Write<Args, Result>
    | Write<[SetStateAction<Value>], void>
    | undefined = maybeWrite

  if (!derived) {
    write ??= defaultWrite
  }

  const init: Value | undefined = derived ? undefined : initialValueOrRead

  const atom = { toString, is, derived, read, write, init }

  return atom
}

function defaultRead<Value>(this: Atom<Value>, get: Getter) {
  return get(this)
}

function defaultWrite<Value>(
  this: PrimitiveAtom<Value>,
  get: Getter,
  set: Setter,
  arg: SetStateAction<Value>,
) {
  return set(
    this,
    typeof arg === 'function'
      ? (arg as (prev: Value) => Value)(get(this))
      : arg,
  )
}
