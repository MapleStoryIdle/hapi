import { useNavigate } from '@tanstack/react-router'
import { Toast } from '@/components/ui/Toast'
import { useToast } from '@/lib/toast-context'

export function ToastContainer() {
    const navigate = useNavigate()
    const { toasts, removeToast } = useToast()

    if (toasts.length === 0) {
        return null
    }

    return (
        <div
            className="pointer-events-none fixed inset-x-0 top-[var(--app-toast-top)] z-50 flex flex-col items-center gap-2 px-3"
            aria-live="polite"
        >
            {toasts.map((toast) => (
                <Toast
                    key={toast.id}
                    kind={toast.kind}
                    title={toast.title}
                    body={toast.body}
                    onNavigate={toast.sessionId || toast.url ? () => {
                        removeToast(toast.id)
                        if (toast.sessionId) {
                            void navigate({
                                to: '/sessions/$sessionId',
                                params: { sessionId: toast.sessionId }
                            })
                            return
                        }
                        if (toast.url) {
                            void navigate({ to: toast.url })
                        }
                    } : undefined}
                    onClose={() => removeToast(toast.id)}
                />
            ))}
        </div>
    )
}
