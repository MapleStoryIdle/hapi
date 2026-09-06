import { useState, type ComponentProps } from 'react'
import { BottomDrawer } from './BottomDrawer'

/** One detail surface: content-sized mobile sheet, existing desktop dialog. */
export function ChatDetailDialog(props: Omit<ComponentProps<typeof BottomDrawer>, 'open' | 'onOpenChange' | 'desktopDialog'> & {
    open?: boolean
    onOpenChange?: (open: boolean) => void
}) {
    const [localOpen, setLocalOpen] = useState(false)
    return <BottomDrawer density="compact" {...props} desktopDialog open={props.open ?? localOpen} onOpenChange={props.onOpenChange ?? setLocalOpen} />
}
