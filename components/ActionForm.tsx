"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/app/actions";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

// A form wired to a server action, with inline error/success messages.
export function ActionForm({
  action,
  children,
  className,
  hidden,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  hidden?: Record<string, string>;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className={className}>
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
      {state?.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="notice ok" role="status">
          {state.ok}
        </p>
      )}
    </form>
  );
}

export function Submit({ children, className, name, value }: { children: ReactNode; className?: string; name?: string; value?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} name={name} value={value}>
      {pending ? "Saving…" : children}
    </button>
  );
}
