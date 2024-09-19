import { type Atom, type WritableAtom } from './atom.ts'
import {
  type FulfilledResource,
  type RejectedResource,
  type Resource,
  type TrackedResource,
  isEqual,
  read,
  replace,
  toRejected,
  toResource,
} from './internal.ts'

export interface Store {
  resource: <Value>(atom: Atom<Value>) => TrackedResource<Awaited<Value>>
  get: <Value>(atom: Atom<Value>) => Value
  set: <Value, Args extends unknown[], Result>(
    atom: WritableAtom<Value, Args, Result>,
    ...args: Args
  ) => Result
  sub: (atom: AnyAtom, subscriber: Subscriber) => Unsubscribe
  reportError: typeof globalThis.reportError
  unstable_derive: (fn: (...args: StoreArgs) => StoreArgs) => Store
}

type GetAtomState = <Value>(
  atom: Atom<Value>,
  originAtomState?: State,
) => State<Value>

// internal & unstable type
type StoreArgs = readonly [
  getAtomState: GetAtomState,
  // possible other arguments in the future
]

// for debugging purpose only
interface DevStore extends Store {
  dev4_get_internal_weak_map: () => {
    get: (atom: AnyAtom) => LegacyState | undefined
  }
  dev4_get_mounted_atoms?: () => Iterable<AnyAtom>
  dev4_restore_atoms?: (values: Iterable<readonly [AnyAtom, AnyValue]>) => void
}

/**
 * Mutable atom state,
 * tracked for both mounted and unmounted atoms in a store.
 */
type LegacyState<Value = AnyValue> = {
  /**
   * Map of atoms that the atom depends on.
   * The map value is the epoch number of the dependency.
   */
  readonly d: Map<AnyAtom, number>
  /**
   * Set of atoms with pending promise that depend on the atom.
   *
   * This may cause memory leaks, but it's for the capability to continue promises
   */
  readonly p: Set<AnyAtom>
  /** The epoch number of the atom. */
  n: number
  /** Object to store mounted state of the atom. */
  m?: LegacyMount | undefined // only available if the atom is mounted
  /** Atom value */
  v?: Value | undefined
  /** Atom error */
  e?: AnyError | undefined
}

/**
 * State tracked for mounted atoms. An atom is considered "mounted" if it has a
 * subscriber, or is a transitive dependency of another atom that has a
 * subscriber.
 *
 * The mounted state of an atom is freed once it is no longer mounted.
 */
type LegacyMount = {
  /** Set of listeners to notify when the atom value changes. */
  readonly l: Set<() => void>
  /** Set of mounted atoms that the atom depends on. */
  readonly d: Set<AnyAtom>
  /** Set of mounted atoms that depends on the atom. */
  readonly t: Set<AnyAtom>
  /** Function to run when the atom is unmounted. */
  u?: OnUnmount | undefined
}

export type INTERNAL_DevStoreRev4 = DevStore
export type INTERNAL_PrdStore = Store

const SUBSCRIBER_INDEX = Symbol('SUBSCRIBER_INDEX')

type AnyValue = unknown
type AnyError = unknown
type AnyContext = Record<string, unknown>
type AnyAtom = Atom<AnyValue>
type AnyWritableAtom = WritableAtom<AnyValue, unknown[], unknown>
type Subscriber = () => void
interface WithSubscriberIndex {
  [SUBSCRIBER_INDEX]: number | undefined
}
type Unsubscribe = () => void
type OnMount = NonNullable<AnyWritableAtom['onMount']>
type OnUnmount = Exclude<ReturnType<OnMount>, void>
type Getter = Parameters<AnyAtom['read']>[0]
type Setter = Parameters<AnyWritableAtom['write']>[1]
type Epoch = number

const FLAGS_ALL = 0b0000000_1111_1111
/** Pushed by a setter so must increment epoch when resource changed */
const FLAGS_SET_PUSH = 0b00_0000_0001
/** Next pull must push */
const FLAGS_DIRTY = 0b00000_0000_0010
/** Next pull must check upstream even if mounted */
const FLAGS_PENDING = 0b000_0000_0100
/** Has (transitive) subscribers */
const FLAGS_MOUNTED = 0b000_0000_1000

/** Queued in `unpulled` to pull on next flush */
const FLAGS_UNPULLED = 0b00_0001_0000
/** Queued in `unmounted` to run `onUnmount` on next flush */
const FLAGS_UNMOUNTED = 0b0_0010_0000
/** Queued in `changed` to notify subscribers on next flush */
const FLAGS_CHANGED = 0b000_0100_0000

const FLAGS_PUSH_STEP = 0b1_0000_0000

/**
 * A state is weakly tracked for each atom within each store it is or has been
 * used in.
 */
type State<TValue = AnyValue> = {
  // TODO 0040 is it ok to strongly hold onto an atom while its derivation
  // is running? -> Testing says yes
  atom: Atom<TValue>
  /**
   * The LSB contains multiple flags about this state (see above).
   * The rest of the bits are used as a push counter to tell apart concurrent
   * pushes which can happen on re-pushes or async pushes.
   */
  flags: number
  /**
   * The epoch where the current resource was set. It represents the resource
   * version and is used in the upstream.
   */
  low: Epoch
  /**
   * The epoch where the upstream was last pulled. It is guaranteed that this
   * state is up to date when the epoch is less than or equal to `high`.
   */
  high: Epoch
  init: TrackedResource<Awaited<TValue>>
  resource: TrackedResource<Awaited<TValue>>
  ctrl: AbortController | undefined
  context: AnyContext | undefined
  upSize: number
  /**
   * List of upstream states _this_ state depends on in the order they were
   * read during the most recent computation.
   */
  upStates: State[] | undefined
  /**
   * Positions of _this_ state in the `downStates` list of each state in
   * `upStates`.
   *
   * Invariant: Must have same order and length as `upStates`
   */
  upBackLinks: number[] | undefined
  /**
   * Epochs of each state in `upStates` at the time they were read during the
   * last computation.
   *
   * Invariant: Must have same order and length as `upStates`
   */
  upEpochs: Epoch[] | undefined
  /**
   * List of mounted downstream states depending on _this_ state.
   */
  downStates: StateWithUpstream[] | undefined
  /**
   * Positions of _this_ state in the `upStates` list of each state in
   * `downStates`.
   *
   * Invariant: Must have same order and length as `downStates`
   */
  downBackLinks: number[] | undefined
  subscribers: Subscriber[] | undefined
  unsubscribes: (Unsubscribe & WithSubscriberIndex)[] | undefined
  /** Function to run when the atom is unmounted. */
  onUnmount: OnUnmount | void
}

type StateWithUpstream<TValue = AnyValue> = State<TValue> &
  Record<'upStates' | 'upBackLinks' | 'upEpochs', object>
function assertUpstream<TValue>(
  downState: State<TValue>,
): asserts downState is StateWithUpstream<TValue> {
  if (downState.upStates === undefined) {
    downState.upStates = []
    downState.upBackLinks = []
    downState.upEpochs = []
  }
}
function hasUpstream<TValue>(
  downState: State<TValue>,
): downState is StateWithUpstream<TValue> {
  return downState.upStates !== undefined && downState.upStates.length > 0
}
function addUpstream(
  downState: StateWithUpstream,
  upLink: number,
  upState: State,
): void {
  downState.upStates[upLink] = upState
  downState.upBackLinks[upLink] ??= 0
  downState.upEpochs[upLink] = upState.high
}
function truncateUpstream(
  downState: StateWithUpstream,
  stateUnmount: (state: State) => void,
): void {
  const { upSize, upStates, upBackLinks, upEpochs } = downState
  for (let upLink = upStates.length - 1; upLink >= upSize; upLink--) {
    const upState = upStates[upLink]!
    if (hasDownstream(upState)) {
      deleteDownstream(downState, upLink, upState)
      stateUnmount(upState)
    }

    upStates.pop()
    upBackLinks.pop()
    upEpochs.pop()
  }
}

type StateWithDownstream<TValue = AnyValue> = State<TValue> &
  Record<'downStates' | 'downBackLinks', object>
function assertDownstream<TValue>(
  upState: State<TValue>,
): asserts upState is StateWithDownstream<TValue> {
  if (upState.downStates === undefined) {
    upState.downStates = []
    upState.downBackLinks = []
  }
}
function hasDownstream<TValue>(
  upState: State<TValue>,
): upState is StateWithDownstream<TValue> {
  return upState.downStates !== undefined && upState.downStates.length > 0
}
function addDownstream(
  downState: StateWithUpstream,
  upLink: number,
  upState: StateWithDownstream,
): void {
  downState.upBackLinks[upLink] = upState.downStates.length
  upState.downStates.push(downState)
  upState.downBackLinks.push(upLink)
}
function deleteDownstream(
  downState: StateWithUpstream,
  upLink: number,
  upState: StateWithDownstream,
): void {
  const { downStates, downBackLinks } = upState

  // "move" the downstream at end of the list into our position unless we are at
  // the end ourselves
  const downLink = downState.upBackLinks[upLink]!
  const lastDownLink = downStates.length - 1
  if (downLink < lastDownLink) {
    const lastDownState = downStates[lastDownLink]!
    const lastUpLink = downBackLinks[lastDownLink]!
    downStates[downLink] = lastDownState
    downBackLinks[downLink] = lastUpLink
    lastDownState.upBackLinks[lastUpLink] = downLink
  }

  downStates.pop()
  downBackLinks.pop()
}
function markDownstreamPending(
  unpulled: State[],
  upState: StateWithDownstream,
): void {
  const { downStates, downBackLinks } = upState
  const { length } = downStates
  for (let downLink = 0; downLink < length; downLink++) {
    const downState = downStates[downLink]!

    // We do not mark a downstream pending that is already
    if (downState.flags & FLAGS_PENDING) {
      continue
    }
    // We do not mark a downstream where we as an upstream are out of bounds.
    // This can happen when we are pulled during a push of the downstream (or
    // a transitive downstream). In this case we are an upstream of a previous
    // push of the downstream and either have not yet been picked up again in
    // the currently ongoing push or will be truncated
    if (downState.upSize <= downBackLinks[downLink]!) {
      continue
    }
    downState.flags |= FLAGS_PENDING

    if (hasDownstream(downState)) {
      markDownstreamPending(unpulled, downState)
    }

    // we append ourselves to `unpulled` after downstream because `unpulled`
    // is processed in reverse
    if (!(downState.flags & FLAGS_UNPULLED) && hasSubscribers(downState)) {
      downState.flags |= FLAGS_UNPULLED
      unpulled.push(downState)
    }
  }
}

type StateWithSubscribers<TValue = AnyValue> = State<TValue> &
  Record<'subscribers' | 'unsubscribes', object>
function assertSubscribers<TValue>(
  state: State<TValue>,
): asserts state is StateWithSubscribers<TValue> {
  if (state.subscribers === undefined) {
    state.subscribers = []
    state.unsubscribes = []
  }
}
function hasSubscribers<TValue>(
  state: State<TValue>,
): state is StateWithSubscribers<TValue> {
  return state.subscribers !== undefined && state.subscribers.length > 0
}

const toCtrl = (ctrl: any): AbortController | undefined => {
  return ctrl instanceof AbortController ? ctrl : undefined
}

type StateWithOnMount<TValue = AnyValue> = State<TValue> & {
  atom: WritableAtom<TValue, unknown[], unknown> & { onMount: OnMount }
}
const isStateWithOnMount = <TValue>(
  state: State<TValue> & { atom: Atom<TValue> & { onMount?: OnMount } },
): state is StateWithOnMount<TValue> => {
  return state.atom.onMount !== undefined
}

export const createStore = (): Store | DevStore => {
  /**
   * The epoch of the store is incremented each time a resource was pushed to
   * a state and the following conditions are met:
   * - The atom of the state is writable
   * - The existing resource is not pending anymore and can therefore not be
   *   replaced
   * - The resource is different from the state's existing resource according to
   *   the `is` method of the state's atom
   */
  let epoch: Epoch = 0

  const states = new WeakMap<AnyAtom, State>()

  let mountedStates: Set<State>
  if (import.meta.env?.MODE !== 'production') {
    mountedStates = new Set()
  }

  /**
   * Returns the atom's state initializing it if necessary.
   */
  const stateGet = <TValue>(
    atom: Atom<TValue> & { init?: Awaited<TValue> | Resource<Awaited<TValue>> },
  ): State<TValue> => {
    let state = states.get(atom) as State<TValue> | undefined
    if (state === undefined) {
      // TODO 0001 this makes "scan" atoms impossible
      // if (atom.derived) {
      //   throw new Error('Derived atoms can not read from themselves')
      // }

      const init = toResource(atom.init!)
      state = {
        atom: atom,
        flags: FLAGS_DIRTY,
        low: epoch,
        high: epoch,
        init,
        resource: init,
        ctrl: undefined,
        context: undefined,
        upSize: 0,
        upStates: undefined,
        upBackLinks: undefined,
        upEpochs: undefined,
        downStates: undefined,
        downBackLinks: undefined,
        subscribers: undefined,
        unsubscribes: undefined,
        onUnmount: undefined,
      }

      states.set(atom, state)
    }

    return state
  }

  /**
   * Updates the state's resource with the given one. The existing resource
   * might be kept if the new resource is equal or if the existing resource was
   * pending and can be "redirected" to the new resource. If this is the case
   * then no downstream notifications are scheduled.
   *
   * The deps of the new resource's derivation should be set in the state before
   * calling this method.
   */
  const statePush = <TValue>(
    state: State<TValue>,
    ctrl?: AbortController,
  ): void => {
    state.flags += FLAGS_PUSH_STEP
    const version = state.flags | FLAGS_ALL

    // abort the previous computation
    // this could re-push which we will check below
    // we also set our `ctrl` so re-pushes can cancel us
    const prevCtrl = state.ctrl
    state.ctrl = ctrl
    prevCtrl?.abort()

    // when the version is smaller than the flags then we were re-pushed
    if (version < state.flags) {
      return
    }

    state.flags &= ~FLAGS_DIRTY
    state.upSize = 0

    let resource: State<TValue>['resource']
    try {
      const push = new Push(state, version)
      resource = toResource(state.atom.read(push.get, push))
    } catch (reason) {
      // TODO 0013 someone could have thrown a promise in a sync derivation
      // how should we handle this?

      resource = toRejected(reason)
    }

    // reading the atom could have re-pushed during onMount of upstream
    if (version < state.flags) {
      return
    }

    if (resource.status === 'rejected') {
      state.ctrl?.abort()
      state.ctrl = undefined
    }

    if (hasUpstream(state)) {
      truncateUpstream(state, stateUnmount)
    }

    state.flags &= ~FLAGS_PENDING

    if (
      state.resource === replace(state.resource, resource) ||
      isEqual(state.resource, resource, state.atom)
    ) {
      state.flags &= ~FLAGS_SET_PUSH
      state.high = epoch
      state.init = state.resource

      // in case we replaced with a sync resource then we need to update the
      // existing resource's tracking information. an existing sync resource
      // does not do this by itself. an existing async resource would do it by
      // itself in the next microtask but this is too slow for us since someone
      // could access this atom in sync and then it should behave like the new
      // state
      if (resource.status === 'fulfilled') {
        state.resource.status = 'fulfilled'
        ;(state.resource as FulfilledResource<Awaited<TValue>>).value =
          resource.value
        state.resource.sync = true
      } else if (resource.status === 'rejected') {
        state.resource.status = 'rejected'
        ;(state.resource as RejectedResource<Awaited<TValue>>).reason =
          resource.reason
        state.resource.sync = true
      }

      return
    }

    // apply the new resource
    epoch += state.flags & FLAGS_SET_PUSH
    state.flags &= ~FLAGS_SET_PUSH
    state.low = epoch
    state.high = epoch
    state.init = resource
    state.resource = resource

    // when we are not mounted we do not need to walk the downstream graph
    if (!(state.flags & FLAGS_MOUNTED)) {
      return
    }

    if (!(state.flags & FLAGS_CHANGED) && hasSubscribers(state)) {
      state.flags |= FLAGS_CHANGED
      changed.push(state)
    }

    if (!hasDownstream(state)) {
      return
    }

    const { downStates, downBackLinks } = state
    const { length } = downStates
    for (let downLink = 0; downLink < length; downLink++) {
      const downState = downStates[downLink]!

      // We do not mark a downstream where we as an upstream are out of bounds.
      // This can happen when we are pulled during a push of the downstream (or
      // a transitive downstream). In this case we are an upstream of a previous
      // push of the downstream and either have not yet been picked up again in
      // the currently ongoing push or will be truncated
      if (downState.upSize <= downBackLinks[downLink]!) {
        continue
      }
      downState.flags |= FLAGS_DIRTY

      // We do not mark a downstream pending that is already
      if (downState.flags & FLAGS_PENDING) {
        continue
      }
      downState.flags |= FLAGS_PENDING

      if (hasDownstream(downState)) {
        markDownstreamPending(unpulled, downState)
      }

      // we append ourselves to `unpulled` after downstream because `unpulled`
      // is processed in reverse
      if (!(downState.flags & FLAGS_UNPULLED) && hasSubscribers(downState)) {
        downState.flags |= FLAGS_UNPULLED
        unpulled.push(downState)
      }
    }
  }

  class Push<TValue> {
    public constructor(
      private readonly state: State<TValue>,
      private readonly version: number,
    ) {}

    public get: Getter = <TUpValue>(upAtom: Atom<TUpValue>): TUpValue => {
      const { state, version } = this
      if ((upAtom as unknown as Atom<TValue>) === state.atom) {
        return read(state.init) as TUpValue
      }

      const upState = stateGet(upAtom)

      track: {
        if (version < state.flags) {
          // TODO 0100 maybe inconsistent read, should we throw?
          statePull(upState)

          break track
        }

        assertUpstream(state)

        const { upSize } = state
        const staleUpState = state.upStates[upSize]
        addUpstream(state, upSize, upState)

        if (!(state.flags & FLAGS_MOUNTED)) {
          statePull(upState)

          state.upSize++

          break track
        }

        if (staleUpState !== undefined && staleUpState !== upState) {
          assertDownstream(staleUpState)
          deleteDownstream(state, upSize, staleUpState)
          stateUnmount(staleUpState)
        }

        stateMountAndPull(upState)
        // mounting could have re-pushed this state
        if (version < state.flags) {
          break track
        }

        if (staleUpState !== upState) {
          assertDownstream(upState)
          addDownstream(state, upSize, upState)
        }

        state.upSize++
      }

      return read(upState.resource) as TUpValue
    }

    public get set() {
      return storeSet
    }

    public get getUntracked() {
      return storeGet
    }

    public get signal(): AbortSignal {
      // signal accessed while we are not the most recent push anymore,
      // so this push is obsolete and is considered aborted
      if (this.version < this.state.flags) {
        const signal = AbortSignal.abort()
        Object.defineProperty(this, 'signal', { value: signal })

        return signal
      }

      // derivation still ongoing, ensure ctrl in state
      this.state.ctrl ??= new AbortController()
      Object.defineProperty(this, 'signal', { value: this.state.ctrl.signal })

      return this.state.ctrl.signal
    }

    public get getSelf(): () => TValue {
      const getSelf: () => TValue = () => read(this.state.init) as TValue

      Object.defineProperty(this, 'getSelf', { value: getSelf })

      return getSelf
    }

    public get setSelf() {
      const setSelf = ((...args: never[]) =>
        storeSet(this.state.atom as AnyWritableAtom, ...args)) as never

      Object.defineProperty(this, 'setSelf', { value: setSelf })

      return setSelf
    }

    public get deriveSelf() {
      const deriveSelf = () => {
        if (this.version < this.state.flags) {
          statePush(this.state)
        }
      }

      Object.defineProperty(this, 'deriveSelf', { value: deriveSelf })

      return deriveSelf
    }

    public get context() {
      this.state.context ??= {}

      return this.state.context
    }
  }

  // ensures state resource is up to date
  const statePull = <TValue>(state: State<TValue>): void => {
    if (state.flags & FLAGS_DIRTY) {
      return statePush(state)
    }

    // mounted atoms that are not pending are up to date
    if (state.flags & FLAGS_MOUNTED && !(state.flags & FLAGS_PENDING)) {
      return
    }

    // Ensure that each upstream is up to date by calling `statePull` on them.
    // If any of them got a new resource, then their respective `low` will have
    // changed compared to our snapshot and we need to re-push.
    if (state.high < epoch && hasUpstream(state)) {
      const { upStates, upEpochs } = state
      const { length } = upStates
      for (let upLink = 0; upLink < length; upLink++) {
        const upState = upStates[upLink]!
        statePull(upState)

        if (upEpochs[upLink] !== upState.low) {
          return statePush(state)
        }
      }
    }

    state.flags &= ~FLAGS_PENDING
    state.high = epoch
  }

  const stateMountAndPull = <TValue>(state: State<TValue>): void => {
    if (state.flags & FLAGS_MOUNTED) {
      return statePull(state)
    }

    state.flags |= FLAGS_MOUNTED
    if (import.meta.env?.MODE !== 'production') {
      mountedStates.add(state)
    }

    mountUpstream: {
      if (state.flags & FLAGS_DIRTY) {
        statePush(state)

        break mountUpstream
      }

      if (hasUpstream(state)) {
        const { upStates, upEpochs } = state
        const { length } = upStates
        for (let upLink = 0; upLink < length; upLink++) {
          const upState = upStates[upLink]!
          stateMountAndPull(upState)
          assertDownstream(upState)
          addDownstream(state, upLink, upState)

          if (upEpochs[upLink] !== upState.low) {
            statePush(state)

            break mountUpstream
          }
        }
      }

      state.flags &= ~FLAGS_PENDING
      state.high = epoch
    }

    if (state.onUnmount === undefined && isStateWithOnMount(state)) {
      try {
        state.onUnmount = state.atom.onMount((...args) =>
          storeSet(state.atom, ...args),
        )
      } catch (e) {
        store.reportError(e)
      }
    }
  }

  const stateUnmount = <TValue>(state: State<TValue>): void => {
    if (!(state.flags & FLAGS_MOUNTED)) {
      return
    }

    // FIXME doesn't work with mutually dependent atoms
    if (hasDownstream(state)) {
      return
    }

    if (hasSubscribers(state)) {
      return
    }

    state.flags &= ~FLAGS_MOUNTED
    if (import.meta.env?.MODE !== 'production') {
      mountedStates.delete(state)
    }

    if (hasUpstream(state)) {
      const { upStates } = state
      const { length } = upStates
      for (let upLink = 0; upLink < length; upLink++) {
        const upState = upStates[upLink]!
        if (hasDownstream(upState)) {
          deleteDownstream(state, upLink, upState)
          stateUnmount(upState)
        }
      }
    }

    if (state.onUnmount !== undefined && !(state.flags & FLAGS_UNMOUNTED)) {
      state.flags |= FLAGS_UNMOUNTED
      unmounted.push(state)
    }

    // TODO 0041 i dont think we should abort on unmount
    // state.ctrl?.abort()
    // state.ctrl = undefined
  }

  const unpulled: State[] = []
  const unmounted: State[] = []
  const changed: StateWithSubscribers[] = []
  let opened = false
  const noop = () => {}
  const open = (): typeof close => {
    if (opened) {
      return noop
    }

    opened = true

    return close
  }
  const close = () => {
    flushUnpulled()
    opened = false
    flushUnmounted()
    flushChanged()
  }
  const flushUnpulled = (): void => {
    for (
      let state = unpulled.pop();
      state !== undefined;
      state = unpulled.pop()
    ) {
      state.flags &= ~FLAGS_UNPULLED
      if (!(state.flags & FLAGS_MOUNTED)) {
        continue
      }

      statePull(state)
    }
  }
  const flushUnmounted = (): void => {
    for (
      let state = unmounted.pop();
      state !== undefined;
      state = unmounted.pop()
    ) {
      state.flags &= ~FLAGS_UNMOUNTED
      if (state.flags & FLAGS_MOUNTED) {
        continue
      }

      const { onUnmount } = state
      if (onUnmount === undefined) {
        continue
      }
      state.onUnmount = undefined

      try {
        onUnmount()
      } catch (e) {
        store.reportError(e)
      }
    }
  }
  const flushChanged = (): void => {
    for (
      let state = changed.pop();
      state !== undefined;
      state = changed.pop()
    ) {
      state.flags &= ~FLAGS_CHANGED

      for (const subscriber of state.subscribers) {
        try {
          subscriber()
        } catch (e) {
          store.reportError(e)
        }
      }
    }
  }

  const storeResource: Store['resource'] = (atom) => {
    const state = stateGet(atom)
    statePull(state)

    return state.resource
  }

  const storeGet: Store['get'] = (atom) => read(storeResource(atom)) as never

  const storeSet: Store['set'] = (atom, ...args) => {
    const setter = ((target: AnyWritableAtom, ...args: unknown[]): unknown => {
      if (target !== atom) {
        return storeSet(target, ...args)
      }

      if (target.derived) {
        // technically possible but restricted as it may cause bugs
        throw new Error('Atom not writable')
      }

      const close = open()
      try {
        const state = stateGet(target)
        state.flags |= FLAGS_SET_PUSH
        state.init = toResource(args[0])
        // TODO 0003 adapt primitive atom to allow abortables as 2nd arg
        // this is to allow primitive atoms with promise values to be aborted
        const ctrl = toCtrl(args[1])
        statePush(state, ctrl)

        return undefined
      } finally {
        close()
      }
    }) as Setter

    const close = open()
    try {
      return atom.write(storeGet, setter, ...args)
    } finally {
      close()
    }
  }

  const storeSub: Store['sub'] = (atom, subscriber) => {
    const close = open()
    const state = stateGet(atom)
    stateMountAndPull(state)
    close()

    assertSubscribers(state)

    const unsubscribe: Unsubscribe & WithSubscriberIndex = () => {
      const index = unsubscribe[SUBSCRIBER_INDEX]
      // we were already unsubscribed
      if (index === undefined) {
        return
      }
      unsubscribe[SUBSCRIBER_INDEX] = undefined

      // "move" the subscriber at end of the list into our position unless we
      // are the at the end ourselves
      const lastIndex = state.subscribers.length - 1
      if (index < lastIndex) {
        state.subscribers[index] = state.subscribers[lastIndex]!
        state.unsubscribes[index] = state.unsubscribes[lastIndex]!
        state.unsubscribes[index]![SUBSCRIBER_INDEX] = index
      }

      state.subscribers.pop()
      state.unsubscribes.pop()

      const close = open()
      stateUnmount(state)
      close()
    }
    unsubscribe[SUBSCRIBER_INDEX] = state.subscribers.length

    state.subscribers.push(subscriber)
    state.unsubscribes.push(unsubscribe)

    return unsubscribe
  }

  const store: Store & Partial<DevStore> = {
    get: storeGet,
    resource: storeResource,
    set: storeSet,
    sub: storeSub,
    reportError: globalThis.reportError ?? console.error,
    unstable_derive: () => {
      throw new Error('Not implemented')
    },
  }

  if (import.meta.env?.MODE !== 'production') {
    // store dev methods (these are tentative and subject to change without notice)
    store.dev4_get_internal_weak_map = () => ({
      get: (atom) => {
        const state = states.get(atom)
        if (state === undefined) {
          return undefined
        }

        const d: LegacyState['d'] = new Map(
          hasUpstream(state)
            ? state.upStates.map((upState, index) => [
                upState.atom,
                state.upEpochs[index] ?? 0,
              ])
            : undefined,
        )

        return {
          d,
          p: new Set(),
          n: state.low,
          m:
            state.flags & FLAGS_MOUNTED
              ? {
                  l: new Set(state.subscribers),
                  d: new Set(d.keys()),
                  t: new Set([
                    atom,
                    ...(state.downStates?.map(({ atom }) => atom) ?? []),
                  ]),
                  u: state.onUnmount ?? undefined,
                }
              : undefined,
          v:
            state.resource.status === 'pending'
              ? state.resource
              : state.resource.status === 'fulfilled'
                ? state.resource.value
                : undefined,
          e:
            state.resource.status === 'rejected'
              ? state.resource.reason
              : undefined,
        }
      },
    })
    store.dev4_get_mounted_atoms = function* () {
      for (const state of mountedStates) {
        yield state.atom
      }
    }
    store.dev4_restore_atoms = (values) => {
      const close = open()

      for (const [atom, value] of values) {
        const state = stateGet(atom)
        if (state.atom.derived) {
          continue
        }

        state.init = toResource(value)
        state.flags |= FLAGS_SET_PUSH
        statePush(state)
      }

      close()
    }
  }

  return store
}

let defaultStore: Store | DevStore | undefined

export const getDefaultStore = (): Store | DevStore => {
  if (defaultStore === undefined) {
    defaultStore = createStore()

    if (import.meta.env?.MODE !== 'production') {
      const global = globalThis as any
      global.__JOTAI_DEFAULT_STORE__ ??= defaultStore
      if (global.__JOTAI_DEFAULT_STORE__ !== defaultStore) {
        console.warn(
          'Detected multiple Jotai instances. It may cause unexpected behavior with the default store. https://github.com/pmndrs/jotai/discussions/2044',
        )
      }
    }
  }

  return defaultStore
}
