import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? "brand-mark small-mark" : "brand-mark"}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 12v8M11 7v18M16 3v26M21 9v14M26 12v8"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function Button({
  children,
  variant = "",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button className={`button ${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Loading({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-label={label}>
      <div className="skeleton skeleton-title" />
      <div className="skeleton" />
      <div className="skeleton" />
      <span className="sr-only">{label}…</span>
    </div>
  );
}
export function Notice({
  children,
  kind = "error",
  retry,
}: {
  children: ReactNode;
  kind?: "error" | "success" | "warn";
  retry?: () => void;
}) {
  return (
    <div
      className={`alert ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      <div>{children}</div>
      {retry && (
        <Button variant="small ghost" onClick={retry}>
          Try again ↻
        </Button>
      )}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-symbol">
        <Mark />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Connection({
  state,
}: {
  state: "connecting" | "connected" | "reconnecting";
}) {
  return (
    <span className={`connection ${state}`} role="status">
      <i />
      {state === "connected"
        ? "Live updates"
        : state === "connecting"
          ? "Connecting…"
          : "Reconnecting · refreshes every 10s"}
    </span>
  );
}
export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (status) {
      const timer = setTimeout(() => setStatus(""), 2500);
      return () => clearTimeout(timer);
    }
  }, [status]);
  return (
    <Button
      variant="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus("Copied");
        } catch {
          setStatus("Select text to copy");
        }
      }}
    >
      <span role="status">{status || label}</span>
    </Button>
  );
}
export function Drawer({
  title,
  children,
  onClose,
  busy,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="drawer-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="drawer-inner">
        <div className="drawer-head">
          <div>
            <p className="eyebrow">Your team</p>
            <h2 id="drawer-title">{title}</h2>
          </div>
          <Button
            variant="icon ghost"
            aria-label="Close editor"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
