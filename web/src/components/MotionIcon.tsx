import { MorphIcon, type IconInput } from 'morphicons/react'
import type { IconNode as LucideIconNode } from 'lucide'
import type { ComponentPropsWithoutRef } from 'react'

type MotionIconProps = Omit<
    ComponentPropsWithoutRef<typeof MorphIcon>,
    'icon' | 'reducedMotion' | 'spring'
> & {
    icon: IconInput
}

const lucideInputs = new WeakMap<LucideIconNode, IconInput>()

/**
 * The version of `lucide` aligned with HAPI's existing `lucide-react`
 * exposes one root `<svg>` tuple. Morphicons consumes its child path tuples.
 * Convert once, retaining an object identity so Morphicons can cache plans.
 */
export function toMotionIcon(icon: LucideIconNode): IconInput {
    const cached = lucideInputs.get(icon)
    if (cached) return cached

    const [tag, , children] = icon
    if (tag !== 'svg' || !children) {
        throw new Error('Expected a Lucide SVG icon node')
    }

    const input: IconInput = children.map(([childTag, childAttributes]) => {
        const attributes: Record<string, string | number | undefined> = {}
        for (const [name, value] of Object.entries(childAttributes)) {
            if (typeof value === 'string' || typeof value === 'number') {
                attributes[name] = value
            }
        }
        return [childTag, attributes] as const
    })
    lucideInputs.set(icon, input)
    return input
}

/**
 * Small shared boundary for meaningful icon state changes.
 *
 * Keep motion opt-in at each call site: this is not a replacement for every
 * static Lucide icon. Test/SSR-like environments without rAF settle instantly.
 */
export function MotionIcon({ icon, ...props }: MotionIconProps) {
    const canAnimate = typeof requestAnimationFrame === 'function'

    return (
        <MorphIcon
            icon={icon}
            spring="snappy"
            reducedMotion={canAnimate ? 'user' : 'always'}
            {...props}
        />
    )
}
