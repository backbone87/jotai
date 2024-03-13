import { type Atom, type WritableAtom } from './atom.ts'
import {
  type FulfilledResource,
  type RejectedResource,
  type UntrackedResource,
  fulfilled,
  isResource,
  rejected,
  track,
} from './internal.ts'

export type Store = {
  get: <Value>(atom: Atom<Value>) => Value
  resource: <Value>(
    atom: Atom<Value>,
  ) =>
    | UntrackedResource<Awaited<Value>>
    | FulfilledResource<Awaited<Value>>
    | RejectedResource<Awaited<Value>>
  set: <Value, Args extends unknown[], Result>(
    atom: WritableAtom<Value, Args, Result>,
    ...args: Args
  ) => Result
  sub: (atom: AnyAtom, listener: () => void) => () => void
  dev_subscribe_store?: (l: StoreListenerRev2, rev: 2) => () => void
  dev_get_mounted_atoms?: () => Iterable<AnyAtom>
  dev_get_atom_state?: (a: AnyAtom) => AtomState<unknown> | undefined
  dev_get_mounted?: (a: AnyAtom) => Mount | undefined
  dev_restore_atoms?: (values: Iterable<readonly [AnyAtom, AnyValue]>) => void
}

type AnyValue = unknown
type AnyError = unknown
type AnyAtom = Atom<AnyValue>
type AnyWritableAtom = WritableAtom<AnyValue, unknown[], unknown>
type OnUnmount = () => void
type Getter = Parameters<AnyAtom['read']>[0]
type Setter = Parameters<AnyWritableAtom['write']>[1]
type Abortable = { abort: () => void }
type Deps = Map<AnyAtom, AtomState>

/**
 * State tracked for mounted atoms. An atom is considered "mounted" if it has a
 * subscriber, or is a transitive dependency of another atom that has a
 * subscriber.
 *
 * The mount state of an atom is freed once it is no longer mounted.
 */
type Mount = {
  /** The list of subscriber functions. */
  l: Set<() => void>
  /** Atoms that depend on *this* atom. Used to fan out invalidation. */
  t: Set<AnyAtom>
  // TODO 0002 experimental mount depth
  // -> unclear if it can fulfill the documented behavior
  // -> only depth computation is implemented for now (search for TODO 0002)
  // /**
  //  * The depth of this mount is used for a more efficient recomputation order
  //  * of dependents.
  //  */
  // d: number
  /** Function to run when the atom is unmounted. */
  u: OnUnmount | void
}

/**
 * Immutable atom state,
 * tracked for both mounted and unmounted atoms in a store.
 */
type AtomState<Value = AnyValue> =
  | { r: UntrackedResource<Awaited<Value>>; v: Value; a: Abortable | void }
  | { r: FulfilledResource<Awaited<Value>>; v: Value; a: Abortable | void }
  | { r: RejectedResource<Awaited<Value>>; v: AnyError; a: Abortable | void }

// for debugging purpose only
type StoreListenerRev2 = (
  action:
    | { type: 'write'; flushed: Set<AnyAtom> }
    | { type: 'async-write'; flushed: Set<AnyAtom> }
    | { type: 'sub'; flushed: Set<AnyAtom> }
    | { type: 'unsub' }
    | { type: 'restore'; flushed: Set<AnyAtom> },
) => void
type FlushType = Exclude<Parameters<StoreListenerRev2>[0]['type'], 'unsub'>

const ASYNC_WRITE: Promise<FlushType> = Promise.resolve('async-write')
const EMPTY_DEPS: Deps = new Map()

const returnAtomValue = <Value>(state: AtomState<Value>): Value => {
  if (state.r.status === 'rejected') {
    throw state.r.reason
  }

  return state.v as Value
}

const invoke = (fn: () => void) => fn()

const abortable = (abortable: any): Abortable | undefined => {
  return abortable !== null &&
    typeof abortable === 'object' &&
    typeof abortable.abort === 'function'
    ? abortable
    : undefined
}

/**
 * Create a new store. Each store is an independent, isolated universe of atom
 * states.
 *
 * Jotai atoms are not themselves state containers. When you read or write an
 * atom, that state is stored in a store. You can think of a Store like a
 * multi-layered map from atoms to states, like this:
 *
 * ```
 * // Conceptually, a Store is a map from atoms to states.
 * // The real type is a bit different.
 * type Store = Map<VersionObject, Map<Atom, AtomState>>
 * ```
 *
 * @returns A store.
 */
export const createStore = (): Store => {
  const contextMap = new WeakMap<AnyAtom, Record<string, unknown>>()
  /**
   * Contains the deps and their state of the most recent computation for an
   * atom. Is also used as a synchronizer pattern in the computation.
   */
  const depsMap = new WeakMap<AnyAtom, Deps>()
  const stateMap = new WeakMap<AnyAtom, AtomState>()
  const mountMap = new Map<AnyAtom, Mount>()
  const changeSet = new Set<Mount>()
  const dirtySet = new Set<AnyAtom>()

  let storeListenersRev2: Set<StoreListenerRev2>
  if (import.meta.env?.MODE !== 'production') {
    storeListenersRev2 = new Set()
  }

  const getAtomState = <Value>(atom: Atom<Value>) =>
    stateMap.get(atom) as AtomState<Value> | undefined

  const createAtomState = <Value, Reject extends boolean>(
    reject: Reject,
    value: Reject extends false ? Value : AnyError,
    abort?: Reject extends false ? Abortable | undefined : never,
  ): AtomState<Value> => {
    if (reject) {
      return { r: rejected(value), v: value, a: undefined }
    }

    if (isResource(value)) {
      return { r: track(value), v: value, a: abort } as AtomState<Value>
    }

    return { r: fulfilled(value), v: value, a: abort } as AtomState<Value>
  }

  const setAtomState = <Value, Rejected extends boolean>(
    atom: Atom<Value>,
    deps: Deps,
    obsoleteDeps: Deps | undefined,
    reject: Rejected,
    value: Rejected extends false ? Value : AnyError,
    abort?: Rejected extends false ? Abortable | undefined : never,
  ): AtomState<Value> => {
    if (obsoleteDeps !== undefined) {
      for (const obsoleteDep of obsoleteDeps.keys()) {
        if (depsMap.get(atom)?.has(obsoleteDep) !== true) {
          unmountAtom(obsoleteDep, atom)
        }
      }
    }

    const existingState = getAtomState(atom)

    // the computation that called `setAtomState` or unmounting obsolete deps
    // could have caused ourselves to be recomputed ("re-entrant") which would
    // make this `setAtomState` call obsolete and therefore `existingState`
    // must contain the most recent state already
    if (depsMap.get(atom) !== deps) {
      // abort this obsolete computation
      abort?.abort()

      if (existingState === undefined) {
        throw new Error('[bug] Re-entrant atoms must have an existing state')
      }

      return existingState
    }

    if (
      existingState !== undefined &&
      (existingState.r.status === 'rejected') === reject &&
      atom.is(existingState.v, value)
    ) {
      existingState.a?.abort()
      existingState.a = abort

      return existingState
    }

    const state = createAtomState(reject, value, abort)
    stateMap.set(atom, state)

    const mount = mountMap.get(atom)
    if (mount !== undefined) {
      console.log('changed mount', atom.debugLabel)
      scheduleFlush()
      changeSet.add(mount)

      for (const dependent of mount.t) {
        console.log('dirty', dependent.debugLabel)
        dirtySet.add(dependent)
      }
    }

    existingState?.a?.abort()

    return state
  }

  class Derive<Value> {
    public ctrl: AbortController | undefined = undefined

    private readonly existingState: AtomState<Value> | undefined

    public constructor(
      private readonly atom: Atom<Value>,
      private readonly deps: Deps,
      public obsoleteDeps: Deps | undefined,
    ) {
      this.existingState = getAtomState(atom)
    }

    public get: Getter = <V>(dep: Atom<V>): V => {
      if ((dep as unknown as Atom<Value>) === this.atom) {
        return this.getSelf() as unknown as V
      }

      // consistent read: if we have read this dep before within this
      // computation return its value
      const existingDepState = this.deps.get(dep) as AtomState<V> | undefined
      if (existingDepState !== undefined) {
        return returnAtomValue(existingDepState)
      }

      // if this is still the current computation and atom is mounted then also
      // mount the dep
      const mount = mountMap.get(this.atom)
      if (mount !== undefined && depsMap.get(this.atom) === this.deps) {
        mountAtom(dep).t.add(this.atom)
      }

      this.obsoleteDeps?.delete(dep)
      const depState = readAtomState(dep)
      this.deps.set(dep, depState)

      // TODO 0002 experimental mount depth
      // if (mount !== undefined && depsMap.get(this.atom) === this.deps) {
      //   const depth = mountMap.get(dep)?.d
      //   if (depth !== undefined && depth >= mount.d) {
      //     mount.d = depth + 1
      //   }
      // }

      return returnAtomValue(depState)
    }

    public get set() {
      return writeAtom
    }

    public get getUntracked() {
      return readAtom
    }

    public get recompute() {
      const recompute = () => {
        if (depsMap.get(this.atom) === this.deps) {
          computeAtomState(this.atom)
        }
      }

      Object.defineProperty(this, 'recompute', { value: recompute })

      return recompute
    }

    public get signal() {
      if (depsMap.get(this.atom) !== this.deps) {
        // signal accessed while we are not the most recent computation
        // anymore, so this computation is obsolete and is considered aborted
        const signal = AbortSignal.abort()
        Object.defineProperty(this, 'signal', { value: signal })

        return signal
      }

      if (this.obsoleteDeps !== undefined) {
        // sync signal access
        // the ctrl will be picked up by `setAtomState` call below
        this.ctrl = new AbortController()
        Object.defineProperty(this, 'signal', { value: this.ctrl.signal })

        return this.ctrl.signal
      }

      // async signal access
      // `setAtomState` call below happened already so we need to handle the
      // atom state directly
      const state = getAtomState(this.atom)
      if (state === undefined) {
        throw new Error('[bug] atom state should exist')
      }

      if (state.r.status === 'rejected') {
        // the computation already failed, abort immediately
        const signal = AbortSignal.abort()
        Object.defineProperty(this, 'signal', { value: signal })

        return signal
      }

      // computation still ongoing, add ctrl to atom state
      this.ctrl = new AbortController()
      state.a = this.ctrl
      Object.defineProperty(this, 'signal', { value: this.ctrl.signal })

      return this.ctrl.signal
    }

    public get getSelf(): () => Value {
      const getSelf: () => Value = () => {
        if (this.existingState !== undefined) {
          return returnAtomValue(this.existingState)
        }

        // TODO 0001 this makes "scan" atoms impossible
        // if (this.atom.derived) {
        //   throw new Error('Derived atoms can not read from themselves')
        // }

        return (this.atom as unknown as { init: Value }).init
      }

      Object.defineProperty(this, 'getSelf', { value: getSelf })

      return getSelf
    }

    public get setSelf() {
      const setSelf = ((...args: never[]) =>
        writeAtom(this.atom as AnyWritableAtom, ...args)) as never

      Object.defineProperty(this, 'setSelf', { value: setSelf })

      return setSelf
    }

    public get context() {
      let context = contextMap.get(this.atom)
      if (context === undefined) {
        context = {}
        contextMap.set(this.atom, context)
      }

      Object.defineProperty(this, 'context', { value: context })

      return context
    }
  }

  const computeAtomState = <Value>(atom: Atom<Value>): AtomState<Value> => {
    console.log('compute', atom.debugLabel)
    dirtySet.delete(atom)

    const obsoleteDeps = depsMap.get(atom)

    const deps: Deps = new Map()
    depsMap.set(atom, deps)

    const derive = new Derive(atom, deps, obsoleteDeps ?? EMPTY_DEPS)

    try {
      let value: Value
      try {
        value = atom.read(derive.get, derive)
      } finally {
        // indicates end of sync derivation
        derive.obsoleteDeps = undefined
      }

      return setAtomState(atom, deps, obsoleteDeps, false, value, derive.ctrl)
    } catch (reason) {
      derive.ctrl?.abort()

      return setAtomState(atom, deps, obsoleteDeps, true, reason)
    }
  }

  const readAtomState = <Value>(atom: Atom<Value>): AtomState<Value> => {
    if (dirtySet.has(atom)) {
      return computeAtomState(atom)
    }

    const state = getAtomState(atom)
    if (state === undefined) {
      return computeAtomState(atom)
    }

    // mounted atoms that are not dirty are always up to date
    if (mountMap.has(atom)) {
      return state
    }

    const deps = depsMap.get(atom)
    // atoms without deps are always up to date
    if (deps === undefined) {
      return state
    }

    // Ensure that each atom we depend on is up to date.
    // Recursive calls to `readAtomState(dep)` will recompute `dep` if
    // it's out of date and if the value did change its state will have changed
    for (const [dep, depState] of deps) {
      if (depState !== readAtomState(dep)) {
        return computeAtomState(atom)
      }
    }

    return state
  }

  const writeAtomState = <Value, Args extends unknown[], Result>(
    atom: WritableAtom<Value, Args, Result>,
    args: Args,
  ): Result => {
    const setter = ((target: AnyWritableAtom, ...args: unknown[]): unknown => {
      if (target !== atom) {
        return writeAtomState(target, args)
      }

      if (target.derived) {
        // technically possible but restricted as it may cause bugs
        throw new Error('Atom not writable')
      }

      depsMap.set(target, EMPTY_DEPS)
      setAtomState(
        target,
        EMPTY_DEPS,
        undefined,
        false,
        args[0],
        // TODO 0003 adapt primitive atom to allow abortables as 2nd arg
        // 10 month later and idk what i intended here
        abortable(args[1]),
      )
      depsMap.delete(target)

      return undefined
    }) as Setter

    return atom.write(readAtom, setter, ...args)
  }

  const mountDeps = <Value>(
    atom: Atom<Value>,
    // TODO 0002 experimental mount depth
    // mount: Mount,
  ): AtomState<Value> => {
    if (dirtySet.has(atom)) {
      return computeAtomState(atom)
    }

    const state = getAtomState(atom)
    if (state === undefined) {
      return computeAtomState(atom)
    }

    const deps = depsMap.get(atom)
    if (deps === undefined) {
      return state
    }

    // TODO 0002 experimental mount depth
    // let depth = 0
    for (const [dep, depState] of deps) {
      // TODO 0005 when `mountAtom` throws we are left in limbo, what to do?
      const depMount = mountAtom(dep)
      depMount.t.add(atom)

      if (depState !== getAtomState(dep)) {
        return computeAtomState(atom)
      }

      // TODO 0002 experimental mount depth
      // if (depMount.d >= depth) {
      //   depth = depMount.d + 1
      // }
    }
    // TODO 0002 experimental mount depth
    // mount.d = depth

    return state
  }

  const mountAtom = <Value>(atom: Atom<Value>): Mount => {
    const existingMount = mountMap.get(atom)
    if (existingMount !== undefined) {
      return existingMount
    }

    const mount: Mount = {
      t: new Set(),
      l: new Set(),
      // TODO 0002 experimental mount depth
      // d: 0,
      u: undefined,
    }
    mountMap.set(atom, mount)

    mountDeps(
      atom,
      // TODO 0002 experimental mount depth
      // mount
    )

    // TODO 0006 when `onMount` throws we are left in limbo, what to do?
    mount.u = (atom as AnyWritableAtom).onMount?.((...args) =>
      writeAtom(atom as AnyWritableAtom, ...args),
    )

    return mount
  }

  const unmountAtom = <Value>(
    atom: Atom<Value>,
    dependent: AnyAtom,
  ): Mount | undefined => {
    const mount = mountMap.get(atom)
    if (mount === undefined) {
      return undefined
    }

    mount.t.delete(dependent)

    // FIXME doesn't work with mutually dependent atoms
    if (mount.l.size > 0 || mount.t.size > 0) {
      return mount
    }

    mountMap.delete(atom)
    changeSet.delete(mount)
    mount.u?.()

    const remount = mountMap.get(atom)
    if (remount !== undefined) {
      return remount
    }

    const deps = depsMap.get(atom)
    if (deps !== undefined) {
      for (const dep of deps.keys()) {
        unmountAtom(dep, atom)

        const remount = mountMap.get(atom)
        if (remount !== undefined) {
          return remount
        }
      }
    }

    getAtomState(atom)?.a?.abort()
    dirtySet.delete(atom)

    return undefined
  }

  let scheduledFlush: Promise<FlushType | void> | undefined
  const scheduleFlush = (): void => {
    scheduledFlush ??= ASYNC_WRITE.then(flush)
  }

  let j = 0
  const flush = (type: FlushType): void => {
    const i = j++
    console.log(i, type)
    // make sure no new flushes are scheduled while flushing
    scheduledFlush ??= ASYNC_WRITE

    let flushed: Set<AnyAtom>
    if (import.meta.env?.MODE !== 'production') {
      flushed = new Set()
    }

    for (const mount of changeSet) {
      for (const [a, m] of mountMap) {
        if (m === mount) {
          console.log(i, 'flush mount of', a.debugLabel)
          break
        }
      }
      for (const atom of dirtySet) {
        console.log(i, 'flush dirty', atom.debugLabel)
        computeAtomState(atom)

        if (import.meta.env?.MODE !== 'production') {
          flushed!.add(atom)
        }
      }

      changeSet.delete(mount)
      mount.l.forEach(invoke)
    }
    console.log(
      i,
      'flushed',
      [...flushed!].map((a) => a.debugLabel),
    )

    scheduledFlush = undefined

    if (import.meta.env?.MODE !== 'production') {
      storeListenersRev2.forEach((l) => l({ type, flushed }))
    }
  }

  const readAtom: Store['get'] = (atom) => returnAtomValue(readAtomState(atom))

  const readAtomResource: Store['resource'] = (atom) => readAtomState(atom).r

  const writeAtom: Store['set'] = (atom, ...args) => {
    scheduleFlush()

    try {
      return writeAtomState(atom, args)
    } finally {
      flush('write')
    }
  }

  const subscribeAtom: Store['sub'] = (atom, listener) => {
    scheduleFlush()
    // TODO 0005 when `mountAtom` throws we are left in limbo, what to do?
    const mount = mountAtom(atom)
    flush('sub')

    mount.l.add(listener)

    return () => {
      mount.l.delete(listener)

      unmountAtom(atom, atom)

      if (import.meta.env?.MODE !== 'production') {
        // devtools uses this to detect if it _can_ unmount or not
        storeListenersRev2.forEach((l) => l({ type: 'unsub' }))
      }
    }
  }

  if (import.meta.env?.MODE !== 'production') {
    return {
      get: readAtom,
      resource: readAtomResource,
      set: writeAtom,
      sub: subscribeAtom,
      // store dev methods (these are tentative and subject to change without notice)
      dev_subscribe_store: (l, rev) => {
        if (rev !== 2) {
          throw new Error('The current StoreListener revision is 2.')
        }

        storeListenersRev2.add(l)

        return () => void storeListenersRev2.delete(l)
      },
      dev_get_mounted_atoms: () => mountMap.keys(),
      dev_get_atom_state: (a) => stateMap.get(a),
      dev_get_mounted: (a) => mountMap.get(a),
      dev_restore_atoms: (values) => {
        scheduleFlush()

        try {
          for (const [atom, value] of values) {
            if (!atom.derived) {
              depsMap.set(atom, EMPTY_DEPS)
              setAtomState(atom, EMPTY_DEPS, undefined, false, value)
              depsMap.delete(atom)
            }
          }
        } finally {
          flush('restore')
        }
      },
    }
  }

  return {
    get: readAtom,
    resource: readAtomResource,
    set: writeAtom,
    sub: subscribeAtom,
  }
}

let defaultStore: Store | undefined

if (import.meta.env?.MODE !== 'production') {
  const global = globalThis as any
  const count = global.__NUMBER_OF_JOTAI_INSTANCES__

  global.__NUMBER_OF_JOTAI_INSTANCES__ =
    typeof count === 'number' ? count + 1 : 1
}

export const getDefaultStore = () => {
  if (import.meta.env?.MODE !== 'production') {
    if (
      defaultStore === undefined &&
      (globalThis as any).__NUMBER_OF_JOTAI_INSTANCES__ !== 1
    ) {
      console.warn(
        'Detected multiple Jotai instances. It may cause unexpected behavior with the default store. https://github.com/pmndrs/jotai/discussions/2044',
      )
    }
  }

  return (defaultStore ??= createStore())
}
