import { type Atom, type WritableAtom } from './atom.ts'
import {
  type FulfilledResource,
  type RejectedResource,
  type UntrackedResource,
  isResource,
  track,
} from './internal.ts'

type AnyValue = unknown
type AnyError = unknown
type AnyAtom = Atom<AnyValue>
type AnyWritableAtom = WritableAtom<AnyValue, unknown[], unknown>
type OnUnmount = () => void
type Getter = Parameters<AnyAtom['read']>[0]
type Setter = Parameters<AnyWritableAtom['write']>[1]
type Abortable = { abort: () => void }

const VALUE = Symbol('VALUE')
const ABORTABLE = Symbol('ABORTABLE')

/**
 * Immutable atom state,
 * tracked for both mounted and unmounted atoms in a store.
 */
type AtomState<Value = AnyValue> =
  | (UntrackedResource<Awaited<Value>> & {
      [ABORTABLE]: Abortable | undefined
      [VALUE]: Value
    })
  | (FulfilledResource<Awaited<Value>> & {
      [ABORTABLE]: Abortable | undefined
      [VALUE]: Value
    })
  | (RejectedResource<Awaited<Value>> & {
      [ABORTABLE]: Abortable | undefined
      [VALUE]: AnyError
    })

const returnAtomValue = <Value>(state: AtomState<Value>): Value => {
  if (state.status === 'rejected') {
    throw state.reason
  }

  return state[VALUE]
}

const invoke = (fn: () => void) => fn()

const abortable = (abortable: any): Abortable | undefined => {
  return abortable !== null &&
    typeof abortable === 'object' &&
    typeof abortable.abort === 'function'
    ? abortable
    : undefined
}

const RESOLVED = Promise.resolve()
const EMPTY_DEPS = new Map()

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
  // TODO experimental mount depth
  // -> unclear if it can fulfill the documented behavior
  // -> only depth computation is implemented for now (search for TODOs)
  // /**
  //  * The depth of this mount is used for a more efficient recomputation order
  //  * of dependents.
  //  */
  // d: number
  /** Function to run when the atom is unmounted. */
  u: OnUnmount | void
}

type Deps = Map<AnyAtom, AtomState>

// for debugging purpose only
type StoreListener = (type: 'state' | 'sub' | 'unsub') => void

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
  dev_subscribe_store?: (l: StoreListener) => () => void
  dev_get_mounted_atoms?: () => Iterable<AnyAtom>
  dev_get_atom_state?: (a: AnyAtom) => AtomState<unknown> | undefined
  dev_get_mounted?: (a: AnyAtom) => Mount | undefined
  dev_restore_atoms?: (values: Iterable<readonly [AnyAtom, AnyValue]>) => void
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

  let storeListeners: Set<StoreListener>
  if (import.meta.env?.MODE !== 'production') {
    storeListeners = new Set()
  }

  const getAtomState = <Value>(atom: Atom<Value>) =>
    stateMap.get(atom) as AtomState<Value> | undefined

  const createAtomState = <Value, Status extends undefined | 'rejected'>(
    status: undefined | 'rejected',
    value: Status extends undefined ? Value : AnyError,
    abort?: Status extends undefined ? Abortable | undefined : never,
  ): AtomState<Value> => {
    if (status === 'rejected') {
      return {
        then: (...args) => Promise.reject(value).then(...args),
        status: 'rejected',
        [VALUE]: value,
        [ABORTABLE]: undefined,
        reason: value,
      }
    }

    if (isResource(value)) {
      const state = track(value) as AtomState<Value>
      state[VALUE] = value as Awaited<Value>
      state[ABORTABLE] = abort

      return state
    }

    return {
      // @ts-expect-error -- too difficult to type properly
      then: (...args) => Promise.resolve(value).then(...args),
      status: 'fulfilled',
      [VALUE]: value as Awaited<Value>,
      [ABORTABLE]: abort,
      value: value as Awaited<Value>,
    }
  }

  const setAtomState = <Value, Status extends undefined | 'rejected'>(
    atom: Atom<Value>,
    deps: Deps,
    obsoleteDeps: Deps | undefined,
    status: Status,
    value: Status extends undefined ? Value : AnyError,
    abort?: Status extends undefined ? Abortable | undefined : never,
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
      (existingState.status === 'rejected') === (status === 'rejected') &&
      atom.is(existingState[VALUE], value)
    ) {
      existingState[ABORTABLE]?.abort()
      existingState[ABORTABLE] = abort

      return existingState
    }

    const state = createAtomState(status, value, abort)
    stateMap.set(atom, state)

    const mount = mountMap.get(atom)
    if (mount !== undefined) {
      scheduleFlush()
      changeSet.add(mount)

      for (const dependent of mount.t) {
        dirtySet.add(dependent)
      }
    }

    existingState?.[ABORTABLE]?.abort()

    return state
  }

  const computeAtomState = <Value>(atom: Atom<Value>): AtomState<Value> => {
    dirtySet.delete(atom)

    let obsoleteDeps = depsMap.get(atom)

    const deps: Deps = new Map()
    depsMap.set(atom, deps)

    const existingState = getAtomState(atom)
    const getter: Getter = <V>(dep: Atom<V>): V => {
      if ((dep as unknown as Atom<Value>) === atom) {
        if (existingState !== undefined) {
          return returnAtomValue(existingState as unknown as AtomState<V>)
        }

        if (dep.derived) {
          throw new Error('Derived atoms can not read from themselves')
        }

        return (dep as unknown as { init: V }).init
      }

      // consistent read: if we have read this dep before within this
      // computation return its value
      const existingDepState = deps.get(dep) as AtomState<V> | undefined
      if (existingDepState !== undefined) {
        return returnAtomValue(existingDepState)
      }

      // if this is still the current computation and atom is mounted then also
      // mount the dep
      const mount = mountMap.get(atom)
      if (mount !== undefined && depsMap.get(atom) === deps) {
        mountAtom(dep).t.add(atom)
      }

      obsoleteDeps?.delete(dep)
      const depState = readAtomState(dep)
      deps.set(dep, depState)

      // TODO experimental mount depth
      // if (mount !== undefined && depsMap.get(atom) === deps) {
      //   const depth = mountMap.get(dep)?.d
      //   if (depth !== undefined && depth >= mount.d) {
      //     mount.d = depth + 1
      //   }
      // }

      return returnAtomValue(depState)
    }

    let ctrl: AbortController | undefined
    const options = {
      set: writeAtom,
      getUntracked: readAtom,
      recompute: () => depsMap.get(atom) === deps && computeAtomState(atom),
      get signal() {
        if (ctrl !== undefined) {
          return ctrl.signal
        }

        ctrl = new AbortController()

        if (depsMap.get(atom) !== deps) {
          // signal accessed while we are not the most recent computation
          // anymore, so this computation is obsolete and is considered aborted
          ctrl.abort()
        } else if (obsoleteDeps === undefined) {
          // signal accessed async, we need to add it to the atom state or abort
          // it if this computation already resulted in an error state
          const state = getAtomState(atom)
          if (state !== undefined) {
            state.status !== 'rejected'
              ? (state[ABORTABLE] = ctrl)
              : ctrl.abort()
          }
        }

        return ctrl.signal
      },
      setSelf: ((...args: unknown[]) =>
        writeAtom(atom as AnyWritableAtom, ...args)) as never,
      get context() {
        const existingContext = contextMap.get(atom)
        if (existingContext !== undefined) {
          return existingContext
        }

        const context = {}
        contextMap.set(atom, context)

        return context
      },
    }

    try {
      const value = atom.read(getter, options)

      return setAtomState(atom, deps, obsoleteDeps, undefined, value, ctrl)
    } catch (reason) {
      ctrl?.abort()

      return setAtomState(atom, deps, obsoleteDeps, 'rejected', reason)
    } finally {
      obsoleteDeps = undefined
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
        undefined,
        args[0],
        abortable(args[1]), // TODO adapt primitive atom to allow abortables as 2nd arg
      )
      depsMap.delete(target)

      return undefined
    }) as Setter

    return atom.write(readAtom, setter, ...args)
  }

  const mountDeps = <Value>(
    atom: Atom<Value>,
    // TODO experimental mount depth
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

    // TODO experimental mount depth
    // let depth = 0
    for (const [dep, depState] of deps) {
      const depMount = mountAtom(dep)
      depMount.t.add(atom)

      if (depState !== getAtomState(dep)) {
        return computeAtomState(atom)
      }

      // TODO experimental mount depth
      // if (depMount.d >= depth) {
      //   depth = depMount.d + 1
      // }
    }
    // TODO experimental mount depth
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
      // TODO experimental mount depth
      // d: 0,
      u: undefined,
    }
    mountMap.set(atom, mount)

    mountDeps(
      atom,
      // TODO experimental mount depth
      // mount
    )

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

    dirtySet.delete(atom)

    return undefined
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- false positive
  let scheduledFlush: Promise<void> | undefined
  const scheduleFlush = (): void => {
    scheduledFlush ??= RESOLVED.then(flush)
  }

  const flush = (): void => {
    scheduledFlush = RESOLVED

    for (const mount of changeSet) {
      for (const atom of dirtySet) {
        computeAtomState(atom)
      }

      changeSet.delete(mount)
      mount.l.forEach(invoke)
    }

    scheduledFlush = undefined

    if (import.meta.env?.MODE !== 'production') {
      storeListeners.forEach((l) => l('state'))
    }
  }

  const readAtom: Store['get'] = (atom) => returnAtomValue(readAtomState(atom))

  const writeAtom: Store['set'] = (atom, ...args) => {
    scheduleFlush()
    const result = writeAtomState(atom, args)
    flush()

    return result
  }

  const subscribeAtom: Store['sub'] = (atom, listener) => {
    scheduleFlush()
    const mount = mountAtom(atom)
    flush()

    mount.l.add(listener)
    if (import.meta.env?.MODE !== 'production') {
      storeListeners.forEach((l) => l('sub'))
    }

    return () => {
      mount.l.delete(listener)

      unmountAtom(atom, atom)
      if (import.meta.env?.MODE !== 'production') {
        // devtools uses this to detect if it _can_ unmount or not
        storeListeners.forEach((l) => l('unsub'))
      }
    }
  }

  if (import.meta.env?.MODE !== 'production') {
    return {
      get: readAtom,
      resource: readAtomState,
      set: writeAtom,
      sub: subscribeAtom,
      // store dev methods (these are tentative and subject to change without notice)
      dev_subscribe_store: (l) => {
        storeListeners.add(l)

        return () => void storeListeners.delete(l)
      },
      dev_get_mounted_atoms: () => mountMap.keys(),
      dev_get_atom_state: (a) => stateMap.get(a),
      dev_get_mounted: (a) => mountMap.get(a),
      dev_restore_atoms: (values) => {
        scheduleFlush()
        for (const [atom, value] of values) {
          if (!atom.derived) {
            depsMap.set(atom, EMPTY_DEPS)
            setAtomState(atom, EMPTY_DEPS, undefined, undefined, value)
            depsMap.delete(atom)
          }
        }
        flush()
      },
    }
  }

  return {
    get: readAtom,
    resource: readAtomState,
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
  if (
    import.meta.env?.MODE !== 'production' &&
    (globalThis as any).__NUMBER_OF_JOTAI_INSTANCES__ !== 1 &&
    defaultStore === undefined
  ) {
    console.warn(
      'Detected multiple Jotai instances. It may cause unexpected behavior with the default store. https://github.com/pmndrs/jotai/discussions/2044',
    )
  }

  return (defaultStore ??= createStore())
}
