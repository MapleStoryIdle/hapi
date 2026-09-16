import type { ComponentProps } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { WorkspaceBrowser } from './WorkspaceBrowser'
import { BottomDrawer } from './ui/BottomDrawer'
import { useTranslation } from '@/lib/use-translation'

export function DirectoryPickerDrawer(props: Omit<ComponentProps<typeof WorkspaceBrowser>, 'actionLabel' | 'onStartSession'> & {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSelect: (machineId: string, directory: string) => void
}) {
    const { t } = useTranslation()
    return (
        <BottomDrawer
            open={props.open}
            onOpenChange={props.onOpenChange}
            title={t('monitors.form.directoryTreeTitle')}
            header={<Dialog.Title className="pl-14 text-center text-base font-semibold sm:pl-0">{t('monitors.form.directoryTreeTitle')}</Dialog.Title>}
            fixedHeight
            density="compact"
            desktopDialog
            desktopClassName="max-w-3xl"
            bodyClassName="file-browser-surface directory-picker-body flex flex-col p-0"
        >
            <div className="min-h-0 flex-1">
                {props.open ? <WorkspaceBrowser
                    api={props.api}
                    machines={props.machines}
                    machinesLoading={props.machinesLoading}
                    initialMachineId={props.initialMachineId}
                    actionLabel={t('monitors.form.selectDirectory')}
                    onStartSession={(machineId, directory) => {
                        props.onSelect(machineId, directory)
                        props.onOpenChange(false)
                    }}
                /> : null}
            </div>
        </BottomDrawer>
    )
}
