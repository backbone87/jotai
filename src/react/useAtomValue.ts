/// <reference types="react/experimental" />

import ReactExports, {
  useDebugValue,
  useEffect,
  useReducer,
  useRef,
} from 'react'
import {
  type TrackedResource,
  use as jotaiUse,
  original,
} from '../vanilla/internal.ts'
import type { Atom, ExtractAtomValue, Store } from '../vanilla.ts'
import { useStore } from './Provider.ts'

const use = ReactExports.use ?? jotaiUse

type State<Value> = {
  store: Store
  atom: Atom<Value>
  value: TrackedResource<Awaited<Value>>
}
type Initializer<Value> = (arg: undefined) => State<Value>

type Instance<Value> = {
  delay: number | undefined
  timeout: ReturnType<typeof setTimeout> | undefined
  unsub: (() => void) | void
  initializer: Initializer<Value>
}

const reducer = <Value>(
  prev: State<Value>,
  next: State<Value>,
): State<Value> => {
  return prev.value === next.value &&
    prev.atom === next.atom &&
    prev.store === next.store
    ? prev
    : next
}

const noop = () => {}

type Options = Parameters<typeof useStore>[0] & {
  delay?: number
}

const finalize = new FinalizationRegistry((instance: Instance<any>) => {
  instance.unsub = instance.unsub?.()
})

export function useAtomValue<Value>(
  atom: Atom<Value>,
  options?: Options,
): Awaited<Value>

export function useAtomValue<AtomType extends Atom<unknown>>(
  atom: AtomType,
  options?: Options,
): Awaited<ExtractAtomValue<AtomType>>

export function useAtomValue<Value>(
  atom: Atom<Value>,
  options?: Options,
): Awaited<Value> {
  const store = useStore(options)
  const ref = useRef(undefined as unknown as Instance<Value>)

  let instance = ref.current
  if (instance === undefined) {
    instance = {
      delay: undefined,
      timeout: undefined,
      unsub: undefined,
      initializer: () => {
        // we need to stop holding onto possibly outdated store and atom
        // as long as react never calls the initializer for a reducer more than
        // once for a single stable instance that is fine
        instance.initializer = noop as unknown as Initializer<Value>

        const value = store.resource(atom)
        // since react 19, initializers of reducers are invoked twice in dev
        // mode, so we additionally need to check if the "out of band"
        // subscription already happened (this double execution happens in the
        // same render, so the above is still fine)
        // in the future we might get rid of this "hack" when react provides a
        // way to track suspended components usages of promises as they already
        // tried to do with the suspense cache
        if (value.status === 'pending' && instance.unsub === undefined) {
          instance.unsub = store.sub(atom, noop)
          finalize.register(ref, instance, ref)
        }

        return { store, atom, value }
      },
    }

    ref.current = instance
  }

  instance.delay = options?.delay
  clearTimeout(instance.timeout)

  const [state, update] = useReducer(
    reducer<Value>,
    undefined,
    instance.initializer,
  )

  let { value } = state
  if (state.store !== store || state.atom !== atom) {
    value = store.resource(atom)
    update({ store, atom, value })
  }

  useEffect(() => {
    const instance = ref.current

    const unsub = store.sub(atom, () => {
      clearTimeout(instance.timeout)

      if (instance.delay === undefined) {
        return update({ store, atom, value: store.resource(atom) })
      }

      // delay rerendering to wait a promise possibly to resolve
      instance.timeout = setTimeout(
        () => update({ store, atom, value: store.resource(atom) }),
        instance.delay,
      )
    })

    if (instance.unsub !== undefined) {
      finalize.unregister(ref)
      instance.unsub = instance.unsub()
    }

    // in case a new resource was set before the effect was called and therefore
    // before we subscribed `update` to the store we just run `update` now.
    // it is a noop if `instance.resource` has not changed
    update({ store, atom, value: store.resource(atom) })

    return () => {
      unsub()
      clearTimeout(instance.timeout)
    }
  }, [store, atom])

  useDebugValue(original(value))

  return use(value)
}
