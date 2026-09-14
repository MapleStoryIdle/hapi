import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** A centred, keyboard-safe dialog: native session IDs are often pasted on mobile. */
export function MonitorTargetSessionDialog(props: {
  open: boolean;
  currentSessionId?: string;
  isPending: boolean;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onSubmit: (sessionId: string) => Promise<void>;
}) {
  const [sessionId, setSessionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setSessionId(props.currentSessionId ?? "");
    setError(null);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 100);
    return () => window.clearTimeout(timer);
  }, [props.currentSessionId, props.open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = sessionId.trim();
    if (!value) {
      setError(props.t("monitors.targetSession.required"));
      return;
    }
    setError(null);
    try {
      await props.onSubmit(value);
      props.onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : props.t("monitors.targetSession.failed"),
      );
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!props.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {props.t("monitors.targetSession.dialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {props.t("monitors.targetSession.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => void submit(event)}
          className="mt-4 space-y-4"
        >
          <label
            className="block text-sm font-medium text-[var(--app-fg)]"
            htmlFor="monitor-codex-session-id"
          >
            {props.t("monitors.targetSession.inputLabel")}
          </label>
          <input
            ref={inputRef}
            id="monitor-codex-session-id"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            disabled={props.isPending}
            maxLength={256}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="ios-form-control w-full px-3 py-2.5 font-mono text-sm"
            placeholder={props.t("monitors.targetSession.placeholder")}
          />
          {error ? (
            <p
              role="alert"
              className="rounded-xl bg-red-500/10 px-3 py-2 text-sm leading-5 text-red-800 dark:text-red-200"
            >
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => props.onOpenChange(false)}
              disabled={props.isPending}
            >
              {props.t("button.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={props.isPending || !sessionId.trim()}
            >
              {props.isPending
                ? props.t("monitors.targetSession.switching")
                : props.t("monitors.targetSession.switch")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
